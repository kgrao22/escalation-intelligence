import { describe, expect, it, vi } from "vitest";
import { parseWorkflowEmbedArgs } from "../src/cli/workflowEmbedArgs.js";
import { parseWorkflowSimilarityArgs } from "../src/cli/workflowSimilarityArgs.js";
import type { EscalationAnalysis } from "../src/llm/schemas/escalationAnalysis.js";
import type { ExtractionOutput } from "../src/persistence/extractionOutput.js";
import {
  buildWorkflowEmbeddingCache,
  lookupWorkflowEmbedding,
  workflowEmbeddingCacheKey,
  workflowEmbeddingOutputFilePath,
  type WorkflowEmbeddingEntry,
  type WorkflowEmbeddingOutput,
} from "../src/persistence/workflowEmbeddingOutput.js";
import { embedWorkflowCandidates, planWorkflowEmbeddingRun } from "../src/workflow/runWorkflowEmbedding.js";
import {
  assertWorkflowPayloadSafe,
  countWorkflowClassifications,
  selectWorkflowEmbeddingCandidates,
  UnsafeWorkflowPayloadError,
  workflowEmbedPayload,
  type WorkflowEmbeddingCandidate,
} from "../src/workflow/workflowEmbeddingCandidates.js";
import {
  computeWorkflowBuckets,
  computeWorkflowPairs,
  splitByClassification,
  summarizeWorkflowSimilarity,
  WORKFLOW_SIMILARITY_BUCKET_BOUNDS,
} from "../src/workflow/workflowSimilarity.js";

const MODEL = "voyage-3";

function analysis(overrides: Partial<EscalationAnalysis>): EscalationAnalysis {
  return {
    rootTs: "1000000000.000100",
    permalink: "https://slack.example/p1000000000000100",
    isTechnicalEscalation: false,
    classification: "operational_request",
    normalizedProblemStatement: null,
    affectedSystem: null,
    issueTypeHint: null,
    severity: "low",
    customerImpact: "none",
    suspectedRootCause: null,
    rootCauseConfidence: null,
    resolutionStatus: "resolved",
    resolutionSummary: null,
    isRecurringEvidenceInThread: false,
    automationCandidate: "process_automation",
    automationReasoning: null,
    confidence: 0.9,
    isAutomationWorkflowCandidate: false,
    workflowClassification: null,
    normalizedWorkflowStatement: null,
    automationStatus: "unknown",
    ...overrides,
  };
}

function extraction(analyses: Array<Partial<EscalationAnalysis>>): ExtractionOutput {
  return {
    metadata: {
      inputFile: "data/slack/escalations-180d-2026-08-12.json",
      analysedAt: "2026-08-12T00:00:00.000Z",
      promptVersion: "v3",
      promptRevision: "v3.1",
      model: "claude-haiku-4-5",
      threadsAvailable: analyses.length,
      threadsAnalysed: analyses.length,
      technicalEscalations: 0,
      nonTechnical: 0,
      failedExtractions: 0,
      sourceWindowDays: 180,
    },
    results: analyses.map((partial, i) => {
      const rootTs = `100000000${i}.000100`;
      return { rootTs, status: "success" as const, analysis: analysis({ ...partial, rootTs }) };
    }),
  };
}

const WORKFLOW_ONLY: Partial<EscalationAnalysis> = {
  isAutomationWorkflowCandidate: true,
  workflowClassification: "policy_cancellation",
  normalizedWorkflowStatement: "Cancel an existing policy by manually updating policy state in backend systems.",
  automationStatus: "manual",
  affectedSystem: "policy-admin",
};

const TECHNICAL_AND_WORKFLOW: Partial<EscalationAnalysis> = {
  isTechnicalEscalation: true,
  classification: "technical_defect",
  normalizedProblemStatement: "Policy documents fail to generate for multi-location risks.",
  isAutomationWorkflowCandidate: true,
  workflowClassification: "manual_document_operation",
  normalizedWorkflowStatement: "Manually regenerate and re-attach policy documents when generation fails.",
  automationStatus: "manual",
};

describe("selectWorkflowEmbeddingCandidates", () => {
  it("selects workflow candidates with a usable statement", () => {
    const candidates = selectWorkflowEmbeddingCandidates(extraction([WORKFLOW_ONLY]));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.statement).toBe(WORKFLOW_ONLY.normalizedWorkflowStatement);
  });

  it("excludes non-workflow threads", () => {
    expect(selectWorkflowEmbeddingCandidates(extraction([{}]))).toHaveLength(0);
  });

  it("excludes a workflow candidate whose statement is null or blank", () => {
    const output = extraction([
      { isAutomationWorkflowCandidate: true, normalizedWorkflowStatement: null },
      { isAutomationWorkflowCandidate: true, normalizedWorkflowStatement: "   " },
    ]);
    expect(selectWorkflowEmbeddingCandidates(output)).toHaveLength(0);
  });

  it("excludes failed extraction records", () => {
    const output = extraction([WORKFLOW_ONLY]);
    output.results.push({ rootTs: "9.9", status: "failed", error: "boom" });
    expect(selectWorkflowEmbeddingCandidates(output)).toHaveLength(1);
  });

  it("retains technical+workflow threads and tags their nature", () => {
    const candidates = selectWorkflowEmbeddingCandidates(extraction([TECHNICAL_AND_WORKFLOW]));
    expect(candidates[0]?.nature).toBe("technical+workflow");
    expect(candidates[0]?.isTechnicalEscalation).toBe(true);
  });

  it("retains workflow-only threads and tags their nature", () => {
    expect(selectWorkflowEmbeddingCandidates(extraction([WORKFLOW_ONLY]))[0]?.nature).toBe("workflow-only");
  });

  it("NEVER uses normalizedProblemStatement as the embed text", () => {
    const candidates = selectWorkflowEmbeddingCandidates(extraction([TECHNICAL_AND_WORKFLOW]));
    expect(candidates[0]?.statement).toBe(TECHNICAL_AND_WORKFLOW.normalizedWorkflowStatement);
    expect(candidates[0]?.statement).not.toBe(TECHNICAL_AND_WORKFLOW.normalizedProblemStatement);
    expect(workflowEmbedPayload(candidates)).not.toContain(TECHNICAL_AND_WORKFLOW.normalizedProblemStatement);
  });

  it("retains the metadata later stages need", () => {
    const candidate = selectWorkflowEmbeddingCandidates(extraction([WORKFLOW_ONLY]))[0];
    expect(candidate).toMatchObject({
      rootTs: "1000000000.000100",
      permalink: "https://slack.example/p1000000000000100",
      workflowClassification: "policy_cancellation",
      automationStatus: "manual",
      isTechnicalEscalation: false,
      classification: "operational_request",
      affectedSystem: "policy-admin",
      resolutionStatus: "resolved",
      automationCandidate: "process_automation",
      nature: "workflow-only",
    });
  });
});

describe("countWorkflowClassifications", () => {
  it("counts by classification, descending", () => {
    const candidates = selectWorkflowEmbeddingCandidates(
      extraction([WORKFLOW_ONLY, WORKFLOW_ONLY, TECHNICAL_AND_WORKFLOW]),
    );
    expect(countWorkflowClassifications(candidates)).toEqual({
      policy_cancellation: 2,
      manual_document_operation: 1,
    });
  });
});

describe("assertWorkflowPayloadSafe — de-identification boundary", () => {
  function candidateWith(statement: string): WorkflowEmbeddingCandidate {
    return {
      rootTs: "1.1",
      permalink: "https://example.slack.com/archives/C1/p1",
      statement,
      workflowClassification: "policy_cancellation",
      automationStatus: "manual",
      isTechnicalEscalation: false,
      classification: "operational_request",
      affectedSystem: null,
      resolutionStatus: "resolved",
      automationCandidate: "process_automation",
      nature: "workflow-only",
    };
  }

  it("accepts a properly de-identified statement", () => {
    expect(() => assertWorkflowPayloadSafe([candidateWith("Cancel an existing policy via backend state update.")])).not.toThrow();
  });

  it.each([
    ["email", "Change the email to meg@example.com for the account."],
    ["Slack permalink", "See https://example.slack.com/archives/C1/p123 for context."],
    ["HubSpot URL", "Per https://app.hubspot.com/contacts/123 update the record."],
    ["Stripe id", "Refund the charge for cus_ABC123456 in billing."],
    ["UUID", "Reset entity 123e4567-e89b-12d3-a456-426614174000 in the system."],
    ["Slack mention", "Ask <@U12345ABC> to move the program back to edit."],
    ["long numeric id", "Reactivate policy 9087654321 for the customer."],
  ])("refuses a statement containing a %s", (_label, statement) => {
    expect(() => assertWorkflowPayloadSafe([candidateWith(statement)])).toThrow(UnsafeWorkflowPayloadError);
  });

  it("refuses an empty statement", () => {
    expect(() => assertWorkflowPayloadSafe([candidateWith("  ")])).toThrow(UnsafeWorkflowPayloadError);
  });

  it("does not reject a permalink held as local metadata", () => {
    // The permalink is on the record but never in the statement.
    const candidate = candidateWith("Cancel an existing policy via backend state update.");
    expect(candidate.permalink).toContain("slack.com");
    expect(() => assertWorkflowPayloadSafe([candidate])).not.toThrow();
    expect(workflowEmbedPayload([candidate])).toEqual(["Cancel an existing policy via backend state update."]);
  });
});

function vec(seed: number, dimension = 4): number[] {
  return Array.from({ length: dimension }, (_, i) => Math.sin(seed + i) + 2);
}

function fakeEmbedFn(calls: string[][]) {
  return vi.fn(async ({ input }: { model: string; input: string[] }) => {
    calls.push(input);
    return { data: input.map((_text, i) => ({ index: i, embedding: vec(calls.length * 10 + i) })) };
  });
}

describe("embedWorkflowCandidates", () => {
  const candidates = selectWorkflowEmbeddingCandidates(
    extraction([WORKFLOW_ONLY, TECHNICAL_AND_WORKFLOW, { ...WORKFLOW_ONLY, normalizedWorkflowStatement: "Reactivate a cancelled policy so coverage resumes." }]),
  );

  it("sends ONLY the workflow statements to the provider", async () => {
    const calls: string[][] = [];
    await embedWorkflowCandidates({ candidates, embedFn: fakeEmbedFn(calls), model: MODEL });

    expect(calls.flat()).toEqual(candidates.map((c) => c.statement));
    const transmitted = JSON.stringify(calls);
    expect(transmitted).not.toContain("slack.example");
    expect(transmitted).not.toContain("1000000000.000100");
    expect(transmitted).not.toContain("policy_cancellation");
    expect(transmitted).not.toContain(TECHNICAL_AND_WORKFLOW.normalizedProblemStatement);
  });

  it("batches according to batchSize", async () => {
    const calls: string[][] = [];
    await embedWorkflowCandidates({ candidates, embedFn: fakeEmbedFn(calls), model: MODEL, batchSize: 2 });
    expect(calls.map((batch) => batch.length)).toEqual([2, 1]);
  });

  it("re-attaches every local metadata field to the vector", async () => {
    const result = await embedWorkflowCandidates({ candidates, embedFn: fakeEmbedFn([]), model: MODEL });
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]).toMatchObject({ nature: "workflow-only", workflowClassification: "policy_cancellation" });
    expect(result.entries[0]?.vector).toHaveLength(4);
  });

  it("refuses to transmit anything when a statement is unsafe", async () => {
    const embedFn = vi.fn();
    const unsafe = [{ ...candidates[0]!, statement: "Update meg@example.com in the dashboard." }];
    await expect(embedWorkflowCandidates({ candidates: unsafe, embedFn, model: MODEL })).rejects.toThrow(
      UnsafeWorkflowPayloadError,
    );
    expect(embedFn).not.toHaveBeenCalled();
  });
});

describe("resumability", () => {
  const candidates = selectWorkflowEmbeddingCandidates(extraction([WORKFLOW_ONLY, TECHNICAL_AND_WORKFLOW]));

  function priorOutput(entries: WorkflowEmbeddingEntry[]): WorkflowEmbeddingOutput {
    return {
      metadata: {
        inputFile: "x", createdAt: "2026-08-12T00:00:00.000Z", embeddingModel: MODEL,
        embeddingDimension: 4, workflowCandidatesAvailable: entries.length,
        successfullyEmbedded: entries.length, failed: 0, workflowClassificationCounts: {},
        extractionPromptVersion: "v3", extractionModel: "claude-haiku-4-5",
        category: "workflow", embeddedField: "normalizedWorkflowStatement", reusedFromCache: 0,
      },
      embeddings: entries,
    };
  }

  it("reuses a cached vector for an identical statement", async () => {
    const cache = buildWorkflowEmbeddingCache([priorOutput([{ ...candidates[0]!, vector: vec(99) }])]);
    const calls: string[][] = [];
    const result = await embedWorkflowCandidates({ candidates, embedFn: fakeEmbedFn(calls), model: MODEL, cache });

    expect(result.reusedFromCache).toBe(1);
    expect(calls.flat()).toEqual([candidates[1]?.statement]);
    expect(result.entries[0]?.vector).toEqual(vec(99));
  });

  it("re-embeds when the statement changed", async () => {
    const stale = { ...candidates[0]!, statement: "An older wording of the same workflow.", vector: vec(99) };
    const cache = buildWorkflowEmbeddingCache([priorOutput([stale])]);
    const calls: string[][] = [];
    const result = await embedWorkflowCandidates({ candidates, embedFn: fakeEmbedFn(calls), model: MODEL, cache });

    expect(result.reusedFromCache).toBe(0);
    expect(calls.flat()).toHaveLength(2);
  });

  it("does not reuse across a different embedding model", () => {
    const cache = buildWorkflowEmbeddingCache([priorOutput([{ ...candidates[0]!, vector: vec(99) }])]);
    expect(lookupWorkflowEmbedding(cache, candidates[0]!, "voyage-other")).toBeUndefined();
    expect(lookupWorkflowEmbedding(cache, candidates[0]!, MODEL)).toBeDefined();
  });

  it("ignores a file that is not a workflow embedding file", () => {
    const technical = priorOutput([{ ...candidates[0]!, vector: vec(99) }]);
    (technical.metadata as { embeddedField: string }).embeddedField = "normalizedProblemStatement";
    expect(buildWorkflowEmbeddingCache([technical]).size).toBe(0);
  });

  it("keys on rootTs, model, and statement together", () => {
    expect(workflowEmbeddingCacheKey("1.1", "a statement", MODEL)).not.toBe(
      workflowEmbeddingCacheKey("1.1", "another statement", MODEL),
    );
  });
});

describe("planWorkflowEmbeddingRun and --limit", () => {
  const candidates = selectWorkflowEmbeddingCandidates(extraction([WORKFLOW_ONLY, TECHNICAL_AND_WORKFLOW]));

  it("estimates payload without any network call", () => {
    const plan = planWorkflowEmbeddingRun(candidates, MODEL);
    expect(plan.candidateCount).toBe(2);
    expect(plan.toEmbed).toBe(2);
    expect(plan.totalPayloadChars).toBe(candidates.reduce((sum, c) => sum + c.statement.length, 0));
    expect(plan.approxTotalTokens).toBe(Math.round(plan.totalPayloadChars / 4));
  });

  it("counts reusable candidates separately", () => {
    const cache = new Map([[workflowEmbeddingCacheKey(candidates[0]!.rootTs, candidates[0]!.statement, MODEL), { ...candidates[0]!, vector: vec(1) }]]);
    const plan = planWorkflowEmbeddingRun(candidates, MODEL, cache);
    expect(plan.reusable).toBe(1);
    expect(plan.toEmbed).toBe(1);
  });

  it("parses --limit, --dry-run, and --input", () => {
    expect(parseWorkflowEmbedArgs([])).toEqual({ input: undefined, dryRun: false, limit: undefined });
    const args = parseWorkflowEmbedArgs(["--input=x.json", "--dry-run", "--limit=5"]);
    expect(args).toEqual({ input: "x.json", dryRun: true, limit: 5 });
  });

  it("rejects a non-positive --limit", () => {
    expect(() => parseWorkflowEmbedArgs(["--limit=0"])).toThrow(/Invalid --limit/);
    expect(() => parseWorkflowEmbedArgs(["--limit=abc"])).toThrow(/Invalid --limit/);
  });
});

describe("workflowEmbeddingOutputFilePath", () => {
  it("uses a prefix that cannot collide with the technical file", () => {
    const at = new Date("2026-08-12T00:00:00.000Z");
    const filePath = workflowEmbeddingOutputFilePath("/d", at, "180d");
    expect(filePath).toContain("workflow-embeddings-180d-2026-08-12.json");
    expect(filePath).not.toMatch(/\/embeddings-180d/);
  });
});

function entry(rootTs: string, vector: number[], overrides: Partial<WorkflowEmbeddingEntry> = {}): WorkflowEmbeddingEntry {
  return {
    rootTs, permalink: `https://slack.example/p${rootTs}`, statement: `statement ${rootTs}`,
    workflowClassification: "policy_cancellation", automationStatus: "manual",
    isTechnicalEscalation: false, classification: "operational_request", affectedSystem: null,
    resolutionStatus: "resolved", automationCandidate: "process_automation",
    nature: "workflow-only", vector, ...overrides,
  };
}

describe("computeWorkflowPairs", () => {
  it("produces n*(n-1)/2 unique pairs with no self-pairs", () => {
    const entries = [entry("1", [1, 0]), entry("2", [0, 1]), entry("3", [1, 1]), entry("4", [2, 1])];
    const pairs = computeWorkflowPairs(entries);
    expect(pairs).toHaveLength(6);
    expect(pairs.every((pair) => pair.a.rootTs !== pair.b.rootTs)).toBe(true);
    const seen = new Set(pairs.map((pair) => [pair.a.rootTs, pair.b.rootTs].sort().join("|")));
    expect(seen.size).toBe(6);
  });

  it("computes cosine similarity correctly", () => {
    const pairs = computeWorkflowPairs([entry("1", [1, 0]), entry("2", [1, 0])]);
    expect(pairs[0]?.similarity).toBeCloseTo(1, 10);
    const orthogonal = computeWorkflowPairs([entry("1", [1, 0]), entry("2", [0, 1])]);
    expect(orthogonal[0]?.similarity).toBeCloseTo(0, 10);
  });

  it("orders deterministically, breaking ties on rootTs", () => {
    const entries = [entry("3", [1, 0]), entry("1", [1, 0]), entry("2", [1, 0])];
    const first = computeWorkflowPairs(entries).map((p) => `${p.a.rootTs}-${p.b.rootTs}`);
    const second = computeWorkflowPairs([...entries].reverse()).map((p) => `${p.a.rootTs}-${p.b.rootTs}`);
    expect(first).toEqual(second);
  });

  it("flags same vs cross classification, treating null as cross", () => {
    const pairs = computeWorkflowPairs([
      entry("1", [1, 0], { workflowClassification: "policy_cancellation" }),
      entry("2", [1, 0], { workflowClassification: "policy_cancellation" }),
      entry("3", [1, 0], { workflowClassification: null }),
      entry("4", [1, 0], { workflowClassification: null }),
    ]);
    expect(pairs.find((p) => p.a.rootTs === "1" && p.b.rootTs === "2")?.sameClassification).toBe(true);
    expect(pairs.find((p) => p.a.rootTs === "3" && p.b.rootTs === "4")?.sameClassification).toBe(false);
  });

  it("carries the fields the reviewer needs on both sides", () => {
    const pair = computeWorkflowPairs([entry("1", [1, 0]), entry("2", [0, 1])])[0];
    for (const side of [pair?.a, pair?.b]) {
      expect(side?.statement).toBeTruthy();
      expect(side?.permalink).toBeTruthy();
      expect(side?.workflowClassification).toBeDefined();
      expect(side?.automationStatus).toBeTruthy();
    }
  });
});

describe("workflow similarity buckets", () => {
  it("covers the whole range with no gaps or overlaps", () => {
    const sorted = [...WORKFLOW_SIMILARITY_BUCKET_BOUNDS].sort((a, b) => a.min - b.min);
    expect(sorted[0]?.min).toBe(Number.NEGATIVE_INFINITY);
    expect(sorted.at(-1)?.max).toBe(Number.POSITIVE_INFINITY);
    for (let i = 0; i < sorted.length - 1; i++) {
      expect(sorted[i]?.max).toBe(sorted[i + 1]?.min);
    }
  });

  it("places boundary values in the higher bucket (min inclusive, max exclusive)", () => {
    const labelFor = (value: number) =>
      computeWorkflowBuckets([value]).find((bucket) => bucket.count === 1)?.label;

    expect(labelFor(0.9)).toBe(">= 0.90");
    expect(labelFor(0.8999)).toBe("0.85 – 0.8999");
    expect(labelFor(0.85)).toBe("0.85 – 0.8999");
    expect(labelFor(0.8)).toBe("0.80 – 0.8499");
    expect(labelFor(0.75)).toBe("0.75 – 0.7999");
    expect(labelFor(0.7)).toBe("0.70 – 0.7499");
    expect(labelFor(0.65)).toBe("0.65 – 0.6999");
    expect(labelFor(0.6)).toBe("0.60 – 0.6499");
    expect(labelFor(0.5999)).toBe("< 0.60");
    expect(labelFor(1)).toBe(">= 0.90");
  });

  it("assigns every similarity to exactly one bucket", () => {
    const values = [1, 0.95, 0.9, 0.87, 0.82, 0.77, 0.72, 0.67, 0.62, 0.5, -0.3];
    const buckets = computeWorkflowBuckets(values);
    expect(buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(values.length);
  });
});

describe("summarizeWorkflowSimilarity and classification split", () => {
  it("reports max, median, and mean", () => {
    const summary = summarizeWorkflowSimilarity(3, [0.2, 0.4, 0.9]);
    expect(summary.max).toBeCloseTo(0.9);
    expect(summary.median).toBeCloseTo(0.4);
    expect(summary.mean).toBeCloseTo(0.5);
    expect(summary.totalPairs).toBe(3);
  });

  it("splits without discarding any pair", () => {
    const pairs = computeWorkflowPairs([
      entry("1", [1, 0], { workflowClassification: "a" }),
      entry("2", [1, 0], { workflowClassification: "a" }),
      entry("3", [0, 1], { workflowClassification: "b" }),
    ]);
    const split = splitByClassification(pairs);
    expect(split.same.totalPairs + split.cross.totalPairs).toBe(pairs.length);
  });

  it("handles an empty similarity list without NaN", () => {
    const summary = summarizeWorkflowSimilarity(0, []);
    expect(summary.max).toBe(0);
    expect(summary.median).toBe(0);
    expect(summary.mean).toBe(0);
  });
});

describe("workflow similarity CLI args", () => {
  it("defaults to the top 30 pairs", () => {
    expect(parseWorkflowSimilarityArgs([])).toEqual({ input: undefined, top: 30 });
  });

  it("parses --input and --top", () => {
    expect(parseWorkflowSimilarityArgs(["--input=w.json", "--top=5"])).toEqual({ input: "w.json", top: 5 });
  });

  it("rejects an invalid --top", () => {
    expect(() => parseWorkflowSimilarityArgs(["--top=-1"])).toThrow(/Invalid --top/);
  });
});
