import { describe, expect, it, vi } from "vitest";
import { parseWorkflowAdjudicateArgs } from "../src/cli/workflowAdjudicateArgs.js";
import {
  buildWorkflowAdjudicationUserPrompt,
  WORKFLOW_ADJUDICATION_PROMPT_VERSION,
  WORKFLOW_ADJUDICATION_SYSTEM_PROMPT,
} from "../src/llm/prompts/workflowAdjudication.js";
import {
  enforceWorkflowNameInvariant,
  WorkflowAdjudicationLLMOutputSchema,
  WORKFLOW_RELATIONSHIPS,
} from "../src/llm/schemas/workflowAdjudication.js";
import type { StructuredParseFn } from "../src/llm/structuredParse.js";
import {
  buildWorkflowAdjudicationCache,
  countWorkflowRelationships,
  lookupWorkflowAdjudication,
  workflowAdjudicationOutputFilePath,
  type WorkflowAdjudicationOutput,
  type WorkflowAdjudicationResultItem,
} from "../src/persistence/workflowAdjudicationOutput.js";
import type { WorkflowEmbeddingEntry } from "../src/persistence/workflowEmbeddingOutput.js";
import { runWorkflowAdjudication } from "../src/workflow/runWorkflowAdjudication.js";
import {
  buildWorkflowCandidatePairs,
  filterBySimilarityBand,
  limitWorkflowCandidates,
  toAdjudicationPayload,
  WORKFLOW_CANDIDATE_SIMILARITY_FLOOR,
  workflowPairId,
} from "../src/workflow/workflowCandidatePairs.js";

const MODEL = "claude-haiku-4-5";

/** Unit vectors at a chosen angle, so cosine similarity is exactly predictable. */
function vectorAtAngle(radians: number): number[] {
  return [Math.cos(radians), Math.sin(radians)];
}

function entry(
  rootTs: string,
  vector: number[],
  overrides: Partial<WorkflowEmbeddingEntry> = {},
): WorkflowEmbeddingEntry {
  return {
    rootTs,
    permalink: `https://example.slack.com/archives/C0SOURCE0000/p${rootTs.replace(".", "")}`,
    // Deliberately free of the rootTs: the privacy tests below assert that no
    // identifier reaches the prompt, which a fixture echoing rootTs would defeat.
    statement: "Cancel an existing policy by manually updating policy state in backend systems.",
    workflowClassification: "policy_state_change",
    automationStatus: "manual",
    isTechnicalEscalation: false,
    classification: "operational_request",
    affectedSystem: "policy-admin",
    resolutionStatus: "resolved",
    automationCandidate: "process_automation",
    nature: "workflow-only",
    vector,
    ...overrides,
  };
}

describe("candidate generation floor", () => {
  it("defaults to 0.80", () => {
    expect(WORKFLOW_CANDIDATE_SIMILARITY_FLOOR).toBe(0.8);
  });

  it("includes a pair exactly at 0.80", () => {
    // cos(theta) = 0.80 exactly.
    const theta = Math.acos(0.8);
    const pairs = buildWorkflowCandidatePairs([entry("1", vectorAtAngle(0)), entry("2", vectorAtAngle(theta))]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.similarity).toBeCloseTo(0.8, 10);
  });

  it("excludes a pair just below 0.80", () => {
    const theta = Math.acos(0.7999);
    const pairs = buildWorkflowCandidatePairs([entry("1", vectorAtAngle(0)), entry("2", vectorAtAngle(theta))]);
    expect(pairs).toHaveLength(0);
  });

  it("includes high-similarity pairs and orders by similarity descending", () => {
    const entries = [
      entry("1", vectorAtAngle(0)),
      entry("2", vectorAtAngle(Math.acos(0.99))),
      entry("3", vectorAtAngle(Math.acos(0.85))),
    ];
    const pairs = buildWorkflowCandidatePairs(entries);
    expect(pairs.length).toBeGreaterThanOrEqual(2);
    expect(pairs[0]!.similarity).toBeGreaterThan(pairs[1]!.similarity);
  });

  it("honours an explicit floor override", () => {
    const entries = [entry("1", vectorAtAngle(0)), entry("2", vectorAtAngle(Math.acos(0.65)))];
    expect(buildWorkflowCandidatePairs(entries, 0.8)).toHaveLength(0);
    expect(buildWorkflowCandidatePairs(entries, 0.6)).toHaveLength(1);
  });
});

describe("cross-classification retention", () => {
  it("RETAINS pairs whose workflowClassification differs", () => {
    const entries = [
      entry("1", vectorAtAngle(0), { workflowClassification: "account_data_update" }),
      entry("2", vectorAtAngle(Math.acos(0.93)), { workflowClassification: "policy_state_change" }),
    ];
    const pairs = buildWorkflowCandidatePairs(entries);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.sameClassification).toBe(false);
  });

  it("retains reactivation ↔ state-change pairs, the calibration example", () => {
    const entries = [
      entry("1", vectorAtAngle(0), { workflowClassification: "policy_reactivation" }),
      entry("2", vectorAtAngle(Math.acos(0.88)), { workflowClassification: "policy_state_change" }),
    ];
    expect(buildWorkflowCandidatePairs(entries)).toHaveLength(1);
  });

  it("marks matching classifications as sameClassification without filtering either way", () => {
    const entries = [
      entry("1", vectorAtAngle(0), { workflowClassification: "policy_cancellation" }),
      entry("2", vectorAtAngle(Math.acos(0.9)), { workflowClassification: "policy_cancellation" }),
      entry("3", vectorAtAngle(Math.acos(0.85)), { workflowClassification: null }),
    ];
    const pairs = buildWorkflowCandidatePairs(entries);
    expect(pairs.filter((p) => p.sameClassification)).toHaveLength(1);
    // Nothing is dropped for being cross-classification.
    expect(pairs.length).toBe(3);
  });

  it("treats null classifications as cross, never as a match", () => {
    const entries = [
      entry("1", vectorAtAngle(0), { workflowClassification: null }),
      entry("2", vectorAtAngle(Math.acos(0.95)), { workflowClassification: null }),
    ];
    expect(buildWorkflowCandidatePairs(entries)[0]?.sameClassification).toBe(false);
  });
});

describe("canonical pair ordering", () => {
  it("sorts the pair id regardless of argument order", () => {
    expect(workflowPairId("2", "1")).toBe(workflowPairId("1", "2"));
  });

  it("puts the lower rootTs on side A regardless of file order", () => {
    const forward = buildWorkflowCandidatePairs([
      entry("1700000002.000100", vectorAtAngle(0)),
      entry("1700000001.000100", vectorAtAngle(Math.acos(0.95))),
    ]);
    const reversed = buildWorkflowCandidatePairs([
      entry("1700000001.000100", vectorAtAngle(Math.acos(0.95))),
      entry("1700000002.000100", vectorAtAngle(0)),
    ]);
    expect(forward[0]?.a.rootTs).toBe("1700000001.000100");
    expect(forward[0]?.pairId).toBe(reversed[0]?.pairId);
    expect(forward[0]?.a.rootTs).toBe(reversed[0]?.a.rootTs);
  });

  it("produces a deterministic ordering across input permutations", () => {
    const entries = [
      entry("3", vectorAtAngle(0)),
      entry("1", vectorAtAngle(Math.acos(0.99))),
      entry("2", vectorAtAngle(Math.acos(0.985))),
    ];
    const first = buildWorkflowCandidatePairs(entries).map((p) => p.pairId);
    const second = buildWorkflowCandidatePairs([...entries].reverse()).map((p) => p.pairId);
    expect(first).toEqual(second);
  });
});

describe("privacy payload boundary", () => {
  const pair = buildWorkflowCandidatePairs([
    entry("1700000001.000100", vectorAtAngle(0)),
    entry("1700000002.000100", vectorAtAngle(Math.acos(0.95))),
  ])[0]!;

  it("projects only the four permitted fields", () => {
    expect(Object.keys(toAdjudicationPayload(pair.a)).sort()).toEqual([
      "automationStatus",
      "nature",
      "normalizedWorkflowStatement",
      "workflowClassification",
    ]);
  });

  it("keeps rootTs and permalink as local metadata only", () => {
    expect(pair.a.rootTs).toBeTruthy();
    expect(pair.a.permalink).toContain("slack.com");
    const payload = JSON.stringify([toAdjudicationPayload(pair.a), toAdjudicationPayload(pair.b)]);
    expect(payload).not.toContain("1700000001.000100");
    expect(payload).not.toContain("slack.com");
  });

  it("builds a user prompt containing no identifiers and no vectors", () => {
    const prompt = buildWorkflowAdjudicationUserPrompt(
      toAdjudicationPayload(pair.a),
      toAdjudicationPayload(pair.b),
      pair.similarity,
    );
    expect(prompt).not.toContain("1700000001");
    expect(prompt).not.toContain("slack.com");
    expect(prompt).not.toMatch(/\[?-?\d+\.\d{6,}/); // no raw vector components
    expect(prompt).toContain("Cancel an existing policy by manually updating policy state");
    expect(prompt).toContain("policy_state_change");
  });

  it("sends nothing but the projection through the parse function", async () => {
    const seen: string[] = [];
    const parseFn: StructuredParseFn<unknown> = vi.fn(async ({ userPrompt, systemPrompt }) => {
      seen.push(userPrompt, systemPrompt);
      return {
        parsed_output: { relationship: "different", confidence: 0.8, reasoning: "r", proposedWorkflowName: null },
        stop_reason: "end_turn",
      };
    });

    await runWorkflowAdjudication({ candidates: [pair], parseFn, model: MODEL });
    const transmitted = seen.join("\n");
    expect(transmitted).not.toContain("1700000001.000100");
    expect(transmitted).not.toContain("example.slack.com");
  });
});

describe("verdict schema", () => {
  it("accepts exactly the three specified relationships", () => {
    expect([...WORKFLOW_RELATIONSHIPS].sort()).toEqual([
      "different",
      "related_workflow_family",
      "same_underlying_workflow",
    ]);
  });

  it("rejects an unknown relationship", () => {
    expect(() =>
      WorkflowAdjudicationLLMOutputSchema.parse({
        relationship: "same_workflow",
        confidence: 0.9,
        reasoning: "r",
        proposedWorkflowName: null,
      }),
    ).toThrow();
  });

  it("keeps a workflow name only on same_underlying_workflow", () => {
    const named = { confidence: 0.9, reasoning: "r", proposedWorkflowName: "Update customer email identity" };
    expect(
      enforceWorkflowNameInvariant({ ...named, relationship: "same_underlying_workflow" as const })
        .proposedWorkflowName,
    ).toBe("Update customer email identity");
    expect(
      enforceWorkflowNameInvariant({ ...named, relationship: "related_workflow_family" as const })
        .proposedWorkflowName,
    ).toBeNull();
    expect(
      enforceWorkflowNameInvariant({ ...named, relationship: "different" as const }).proposedWorkflowName,
    ).toBeNull();
  });

  it("teaches the prompt not to let classification override semantics", () => {
    const prompt = WORKFLOW_ADJUDICATION_SYSTEM_PROMPT.toLowerCase();
    expect(prompt).toContain("weak evidence only");
    expect(prompt).toContain('never answer "different" merely because the classifications differ');
    expect(prompt).toContain("account_data_update");
    for (const relationship of WORKFLOW_RELATIONSHIPS) {
      expect(WORKFLOW_ADJUDICATION_SYSTEM_PROMPT).toContain(relationship);
    }
  });
});

function fakeParseFn(relationship: string) {
  return vi.fn(async () => ({
    parsed_output: {
      relationship,
      confidence: 0.9,
      reasoning: "Same task.",
      proposedWorkflowName: relationship === "same_underlying_workflow" ? "Cancel a policy" : null,
    },
    stop_reason: "end_turn",
  })) as unknown as StructuredParseFn<unknown>;
}

describe("runWorkflowAdjudication", () => {
  const candidates = buildWorkflowCandidatePairs([
    entry("1", vectorAtAngle(0)),
    entry("2", vectorAtAngle(Math.acos(0.95))),
    entry("3", vectorAtAngle(Math.acos(0.9))),
  ]);

  it("records a verdict per pair with local metadata preserved", async () => {
    const results = await runWorkflowAdjudication({
      candidates,
      parseFn: fakeParseFn("same_underlying_workflow"),
      model: MODEL,
    });
    expect(results).toHaveLength(candidates.length);
    expect(results[0]?.status).toBe("success");
    expect(results[0]?.relationship).toBe("same_underlying_workflow");
    expect(results[0]?.a.rootTs).toBeTruthy();
    expect(results[0]?.a.permalink).toContain("slack.com");
  });

  it("records a failure and continues rather than losing earlier work", async () => {
    let call = 0;
    const parseFn: StructuredParseFn<unknown> = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        throw new Error("boom");
      }
      return {
        parsed_output: { relationship: "different", confidence: 0.5, reasoning: "r", proposedWorkflowName: null },
        stop_reason: "end_turn",
      };
    });

    const results = await runWorkflowAdjudication({
      candidates,
      parseFn,
      model: MODEL,
      retryOptions: { maxAttempts: 1, baseDelayMs: 0 },
    });
    expect(results[0]?.status).toBe("failed");
    expect(results.filter((r) => r.status === "success")).toHaveLength(candidates.length - 1);
  });

  it("rejects a response the schema cannot accept", async () => {
    const parseFn: StructuredParseFn<unknown> = vi.fn(async () => ({
      parsed_output: { relationship: "totally_made_up", confidence: 0.9, reasoning: "r", proposedWorkflowName: null },
      stop_reason: "end_turn",
    }));
    const results = await runWorkflowAdjudication({
      candidates: [candidates[0]!],
      parseFn,
      model: MODEL,
      retryOptions: { maxAttempts: 1, baseDelayMs: 0 },
    });
    expect(results[0]?.status).toBe("failed");
  });
});

describe("resumability", () => {
  const candidates = buildWorkflowCandidatePairs([
    entry("1", vectorAtAngle(0)),
    entry("2", vectorAtAngle(Math.acos(0.95))),
  ]);

  function priorOutput(
    results: WorkflowAdjudicationResultItem[],
    promptVersion = WORKFLOW_ADJUDICATION_PROMPT_VERSION,
    model = MODEL,
  ): WorkflowAdjudicationOutput {
    return {
      metadata: {
        inputFile: "x", createdAt: "2026-08-13T00:00:00.000Z", similarityFloor: 0.8,
        totalEmbeddings: 2, possiblePairs: 1, candidatePairs: 1, adjudicatedPairs: 1,
        sameUnderlyingWorkflow: 1, relatedWorkflowFamily: 0, different: 0, failed: 0,
        reusedFromCache: 0, crossClassificationCandidates: 0, model, promptVersion, category: "workflow",
      },
      results,
    };
  }

  const priorSuccess: WorkflowAdjudicationResultItem = {
    pairId: candidates[0]!.pairId,
    similarity: 0.95,
    a: candidates[0]!.a,
    b: candidates[0]!.b,
    sameClassification: true,
    status: "success",
    relationship: "same_underlying_workflow",
    confidence: 0.88,
    reasoning: "Prior verdict.",
    proposedWorkflowName: "Cancel a policy",
  };

  it("reuses a cached verdict without calling the LLM", async () => {
    const parseFn = vi.fn() as unknown as StructuredParseFn<unknown>;
    const cache = buildWorkflowAdjudicationCache([priorOutput([priorSuccess])]);
    const results = await runWorkflowAdjudication({ candidates, parseFn, model: MODEL, cache });

    expect(parseFn).not.toHaveBeenCalled();
    expect(results[0]?.reasoning).toBe("Prior verdict.");
  });

  it("does not reuse across a different prompt version or model", () => {
    const cache = buildWorkflowAdjudicationCache([priorOutput([priorSuccess])]);
    expect(lookupWorkflowAdjudication(cache, priorSuccess.pairId, "v1", MODEL)).toBeUndefined();
    expect(lookupWorkflowAdjudication(cache, priorSuccess.pairId, WORKFLOW_ADJUDICATION_PROMPT_VERSION, "other")).toBeUndefined();
    expect(lookupWorkflowAdjudication(cache, priorSuccess.pairId, WORKFLOW_ADJUDICATION_PROMPT_VERSION, MODEL)).toBeDefined();
  });

  it("never caches a failure, so it is retried", () => {
    const failure: WorkflowAdjudicationResultItem = { ...priorSuccess, status: "failed", relationship: undefined, error: "boom" };
    expect(buildWorkflowAdjudicationCache([priorOutput([failure])]).size).toBe(0);
  });

  it("reuses prior results when re-run with a larger limit", async () => {
    const three = buildWorkflowCandidatePairs([
      entry("1", vectorAtAngle(0)),
      entry("2", vectorAtAngle(Math.acos(0.95))),
      entry("3", vectorAtAngle(Math.acos(0.9))),
    ]);
    const firstRun = await runWorkflowAdjudication({
      candidates: limitWorkflowCandidates(three, 1),
      parseFn: fakeParseFn("same_underlying_workflow"),
      model: MODEL,
    });

    const parseFn = fakeParseFn("different");
    const secondRun = await runWorkflowAdjudication({
      candidates: three,
      parseFn,
      model: MODEL,
      cache: buildWorkflowAdjudicationCache([priorOutput(firstRun)]),
    });

    expect(secondRun).toHaveLength(3);
    expect(secondRun[0]?.relationship).toBe("same_underlying_workflow"); // reused
    expect(parseFn).toHaveBeenCalledTimes(2); // only the two new pairs
  });
});

describe("countWorkflowRelationships", () => {
  it("tallies each verdict and ignores failures", () => {
    const base = { similarity: 0.9, a: {} as never, b: {} as never, sameClassification: true };
    const counts = countWorkflowRelationships([
      { ...base, pairId: "1", status: "success", relationship: "same_underlying_workflow" },
      { ...base, pairId: "2", status: "success", relationship: "related_workflow_family" },
      { ...base, pairId: "3", status: "success", relationship: "different" },
      { ...base, pairId: "4", status: "failed", error: "boom" },
    ]);
    expect(counts).toEqual({ sameUnderlyingWorkflow: 1, relatedWorkflowFamily: 1, different: 1 });
  });
});

describe("CLI args and output path", () => {
  it("defaults the floor to 0.80 with no limit", () => {
    expect(parseWorkflowAdjudicateArgs([])).toEqual({
      embeddings: undefined, dryRun: false, limit: undefined, floor: 0.8,
      minSimilarity: undefined, maxSimilarity: undefined, inspect: false,
    });
  });

  it("parses --embeddings, --dry-run, --limit, and --floor", () => {
    expect(parseWorkflowAdjudicateArgs(["--embeddings=w.json", "--dry-run", "--limit=10", "--floor=0.85"])).toEqual({
      embeddings: "w.json", dryRun: true, limit: 10, floor: 0.85,
      minSimilarity: undefined, maxSimilarity: undefined, inspect: false,
    });
  });

  it("rejects invalid --limit and --floor", () => {
    expect(() => parseWorkflowAdjudicateArgs(["--limit=0"])).toThrow(/Invalid --limit/);
    expect(() => parseWorkflowAdjudicateArgs(["--floor=1.5"])).toThrow(/Invalid --floor/);
  });

  it("limits candidates without reordering them", () => {
    const three = buildWorkflowCandidatePairs([
      entry("1", vectorAtAngle(0)),
      entry("2", vectorAtAngle(Math.acos(0.95))),
      entry("3", vectorAtAngle(Math.acos(0.9))),
    ]);
    expect(limitWorkflowCandidates(three, 2)).toEqual(three.slice(0, 2));
    expect(limitWorkflowCandidates(three, undefined)).toHaveLength(three.length);
  });

  it("writes to a filename that cannot collide with the technical track", () => {
    const filePath = workflowAdjudicationOutputFilePath("/d", new Date("2026-08-13T00:00:00.000Z"), "180d");
    expect(filePath).toContain("workflow-adjudications-180d-2026-08-13.json");
    expect(filePath).not.toMatch(/\/adjudications-180d/);
  });
});

describe("no Slack involvement", () => {
  it("does not import any Slack client in the workflow adjudication path", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const file of [
      "src/cli/intelligence-workflow-adjudicate.ts",
      "src/workflow/runWorkflowAdjudication.ts",
      "src/workflow/workflowCandidatePairs.ts",
    ]) {
      const source = await readFile(file, "utf8");
      expect(source).not.toContain("@slack/web-api");
      expect(source).not.toMatch(/chat\.postMessage/);
    }
  });
});

describe("similarity band selection", () => {
  // Similarities: 0.99, 0.90, 0.85, 0.84, 0.80 against the reference vector.
  const reference = entry("1", vectorAtAngle(0));
  const graded = [
    reference,
    entry("2", vectorAtAngle(Math.acos(0.99))),
    entry("3", vectorAtAngle(Math.acos(0.9))),
    entry("4", vectorAtAngle(Math.acos(0.85))),
    entry("5", vectorAtAngle(Math.acos(0.84))),
    entry("6", vectorAtAngle(Math.acos(0.8))),
  ];
  const candidates = buildWorkflowCandidatePairs(graded);

  function similaritiesWithin(band: { min?: number; max?: number }): number[] {
    return filterBySimilarityBand(candidates, band).map((pair) => pair.similarity);
  }

  it("treats min as INCLUSIVE", () => {
    const selected = similaritiesWithin({ min: 0.85 });
    expect(selected.some((value) => Math.abs(value - 0.85) < 1e-9)).toBe(true);
    expect(selected.every((value) => value >= 0.85 - 1e-9)).toBe(true);
  });

  it("treats max as EXCLUSIVE", () => {
    const selected = similaritiesWithin({ max: 0.85 });
    expect(selected.some((value) => Math.abs(value - 0.85) < 1e-9)).toBe(false);
    expect(selected.every((value) => value < 0.85)).toBe(true);
  });

  it("selects the half-open band [min, max) when both are given", () => {
    const selected = similaritiesWithin({ min: 0.8, max: 0.85 });
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.every((value) => value >= 0.8 - 1e-9 && value < 0.85)).toBe(true);
    // Nothing outside the band survives.
    expect(selected).toHaveLength(
      candidates.filter((pair) => pair.similarity >= 0.8 && pair.similarity < 0.85).length,
    );
  });

  it("leaves the candidate set untouched when no band is given", () => {
    expect(filterBySimilarityBand(candidates, {})).toEqual(candidates);
  });

  it("returns an empty set for a band containing nothing", () => {
    // Derived from the fixture rather than guessed: strictly above every pair.
    const highest = Math.max(...candidates.map((pair) => pair.similarity));
    expect(similaritiesWithin({ min: highest + 1e-6 })).toEqual([]);
    expect(similaritiesWithin({ max: 0.5 })).toEqual([]);
  });

  it("selects exactly the pairs whose similarity falls in the band", () => {
    const band = { min: 0.9, max: 0.95 };
    const expected = candidates
      .filter((pair) => pair.similarity >= band.min && pair.similarity < band.max)
      .map((pair) => pair.pairId);
    expect(filterBySimilarityBand(candidates, band).map((pair) => pair.pairId)).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  });

  it("applies the band BEFORE the limit", () => {
    const band = filterBySimilarityBand(candidates, { min: 0.8, max: 0.85 });
    const limited = limitWorkflowCandidates(band, 1);

    expect(limited).toHaveLength(1);
    // The top of the BAND, not the top overall.
    expect(limited[0]?.similarity).toBeCloseTo(band[0]!.similarity, 9);
    expect(limited[0]?.similarity).toBeLessThan(0.85);
    expect(candidates[0]!.similarity).toBeGreaterThan(0.85);

    // Limiting first would have taken the top pair overall and then filtered it away.
    const wrongOrder = filterBySimilarityBand(limitWorkflowCandidates(candidates, 1), { min: 0.8, max: 0.85 });
    expect(wrongOrder).toHaveLength(0);
  });

  it("keeps band results ordered by similarity descending", () => {
    const band = filterBySimilarityBand(candidates, { min: 0.8, max: 0.9 });
    const sims = band.map((pair) => pair.similarity);
    expect([...sims].sort((a, b) => b - a)).toEqual(sims);
  });
});

describe("band argument validation", () => {
  it("parses --min-similarity, --max-similarity, and --inspect", () => {
    const args = parseWorkflowAdjudicateArgs([
      "--min-similarity=0.80",
      "--max-similarity=0.85",
      "--limit=20",
      "--inspect",
    ]);
    expect(args.minSimilarity).toBe(0.8);
    expect(args.maxSimilarity).toBe(0.85);
    expect(args.limit).toBe(20);
    expect(args.inspect).toBe(true);
  });

  it("defaults the band to undefined and inspect to false", () => {
    const args = parseWorkflowAdjudicateArgs([]);
    expect(args.minSimilarity).toBeUndefined();
    expect(args.maxSimilarity).toBeUndefined();
    expect(args.inspect).toBe(false);
    expect(args.floor).toBe(0.8);
  });

  it("rejects out-of-range values", () => {
    expect(() => parseWorkflowAdjudicateArgs(["--min-similarity=1.4"])).toThrow(/Invalid --min-similarity/);
    expect(() => parseWorkflowAdjudicateArgs(["--max-similarity=-0.2"])).toThrow(/Invalid --max-similarity/);
    expect(() => parseWorkflowAdjudicateArgs(["--min-similarity=abc"])).toThrow(/Invalid --min-similarity/);
  });

  it("rejects min >= max", () => {
    expect(() =>
      parseWorkflowAdjudicateArgs(["--min-similarity=0.85", "--max-similarity=0.85"]),
    ).toThrow(/must be less than/);
    expect(() =>
      parseWorkflowAdjudicateArgs(["--min-similarity=0.9", "--max-similarity=0.85"]),
    ).toThrow(/must be less than/);
  });

  it("refuses a min below the floor unless --floor explicitly permits it", () => {
    expect(() => parseWorkflowAdjudicateArgs(["--min-similarity=0.7"])).toThrow(
      /below the candidate floor/,
    );
    const permitted = parseWorkflowAdjudicateArgs(["--floor=0.7", "--min-similarity=0.7"]);
    expect(permitted.floor).toBe(0.7);
    expect(permitted.minSimilarity).toBe(0.7);
  });

  it("allows a min at or above the floor without --floor", () => {
    expect(parseWorkflowAdjudicateArgs(["--min-similarity=0.8"]).minSimilarity).toBe(0.8);
    expect(parseWorkflowAdjudicateArgs(["--min-similarity=0.9"]).minSimilarity).toBe(0.9);
  });
});

describe("cache survives band selection", () => {
  const graded = [
    entry("1", vectorAtAngle(0)),
    entry("2", vectorAtAngle(Math.acos(0.99))),
    entry("3", vectorAtAngle(Math.acos(0.84))),
  ];
  const candidates = buildWorkflowCandidatePairs(graded);

  function outputFrom(results: WorkflowAdjudicationResultItem[]): WorkflowAdjudicationOutput {
    return {
      metadata: {
        inputFile: "x", createdAt: "2026-08-14T00:00:00.000Z", similarityFloor: 0.8,
        totalEmbeddings: 3, possiblePairs: 3, candidatePairs: results.length,
        adjudicatedPairs: results.length, sameUnderlyingWorkflow: results.length,
        relatedWorkflowFamily: 0, different: 0, failed: 0, reusedFromCache: 0,
        crossClassificationCandidates: 0, model: MODEL,
        promptVersion: WORKFLOW_ADJUDICATION_PROMPT_VERSION, category: "workflow",
      },
      results,
    };
  }

  it("reuses a verdict recorded by a high-band run in a later unfiltered run", async () => {
    const highBand = filterBySimilarityBand(candidates, { min: 0.9 });
    expect(highBand.length).toBeGreaterThan(0);

    const firstRun = await runWorkflowAdjudication({
      candidates: highBand,
      parseFn: fakeParseFn("same_underlying_workflow"),
      model: MODEL,
    });

    const parseFn = fakeParseFn("different");
    const secondRun = await runWorkflowAdjudication({
      candidates,
      parseFn,
      model: MODEL,
      cache: buildWorkflowAdjudicationCache([outputFrom(firstRun)]),
    });

    const reused = secondRun.filter((r) => r.relationship === "same_underlying_workflow");
    expect(reused).toHaveLength(highBand.length);
    expect(parseFn).toHaveBeenCalledTimes(candidates.length - highBand.length);
  });

  it("keys the cache on pair identity only, so band choice cannot invalidate it", () => {
    const results = candidates.map((pair) => ({
      pairId: pair.pairId, similarity: pair.similarity, a: pair.a, b: pair.b,
      sameClassification: pair.sameClassification, status: "success" as const,
      relationship: "same_underlying_workflow" as const, confidence: 0.9,
      reasoning: "r", proposedWorkflowName: "Cancel a policy",
    }));
    const cache = buildWorkflowAdjudicationCache([outputFrom(results)]);

    // Every pair resolves regardless of which band would have selected it.
    for (const pair of candidates) {
      expect(
        lookupWorkflowAdjudication(cache, pair.pairId, WORKFLOW_ADJUDICATION_PROMPT_VERSION, MODEL),
      ).toBeDefined();
    }
  });
});

describe("inspect mode", () => {
  it("is a local-only flag that never reaches the LLM path", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/cli/intelligence-workflow-adjudicate.ts", "utf8");

    // The inspect branch must return before the Anthropic client is constructed.
    const inspectAt = source.indexOf("if (args.inspect)");
    const clientAt = source.indexOf("new Anthropic(");
    expect(inspectAt).toBeGreaterThan(-1);
    expect(clientAt).toBeGreaterThan(inspectAt);
    expect(source.slice(inspectAt, clientAt)).toContain("Zero Anthropic API calls made");
    expect(source.slice(inspectAt, clientAt)).toContain("return;");
  });

  it("prints the local fields a human reviewer needs", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/cli/intelligence-workflow-adjudicate.ts", "utf8");
    const inspectBlock = source.slice(source.indexOf("if (args.inspect)"), source.indexOf("new Anthropic("));

    for (const field of [
      "normalizedWorkflowStatement",
      "workflowClassification",
      "automationStatus",
      "permalink",
      "similarity",
      "sameClassification",
    ]) {
      expect(inspectBlock).toContain(field);
    }
  });
});

/**
 * pairId is a sorted rootTs pair, so a thread appearing in two windows produces
 * the SAME key under the same prompt and model — exactly the contamination that
 * hit the technical stages. Reuse is therefore scoped by the upstream
 * workflow-embeddings artifact.
 */
describe("workflow adjudication provenance isolation across windows", () => {
  const EMB_365 = "data/intelligence/workflow-embeddings-365d-2026-08-14.json";
  const EMB_180 = "data/intelligence/workflow-embeddings-180d-2026-08-13.json";

  function outputFrom(inputFile: string, pairIds: string[]): WorkflowAdjudicationOutput {
    return {
      metadata: {
        inputFile, createdAt: "2026-08-13T00:00:00.000Z", similarityFloor: 0.8,
        totalEmbeddings: 2, possiblePairs: 1, candidatePairs: pairIds.length,
        adjudicatedPairs: pairIds.length, sameUnderlyingWorkflow: pairIds.length,
        relatedWorkflowFamily: 0, different: 0, failed: 0, reusedFromCache: 0,
        crossClassificationCandidates: 0, model: MODEL,
        promptVersion: WORKFLOW_ADJUDICATION_PROMPT_VERSION, category: "workflow",
      },
      results: pairIds.map((pairId) => ({
        pairId, similarity: 0.9, a: {} as never, b: {} as never, sameClassification: true,
        status: "success" as const, relationship: "same_underlying_workflow" as const,
        confidence: 0.9, reasoning: "prior", proposedWorkflowName: "A workflow",
      })),
    };
  }

  /** Mirrors the filter the CLI applies before building the cache. */
  function scope(outputs: WorkflowAdjudicationOutput[], inputFile: string): WorkflowAdjudicationOutput[] {
    return outputs.filter((output) => output.metadata.inputFile === inputFile);
  }

  it("does not reuse a 180d verdict during a 365d run", () => {
    const pairId = workflowPairId("1700000001.000100", "1700000002.000100");
    const cache = buildWorkflowAdjudicationCache(scope([outputFrom(EMB_180, [pairId])], EMB_365));
    expect(lookupWorkflowAdjudication(cache, pairId, WORKFLOW_ADJUDICATION_PROMPT_VERSION, MODEL)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("still reuses verdicts from the same embeddings artifact", () => {
    const pairId = workflowPairId("1700000001.000100", "1700000002.000100");
    const cache = buildWorkflowAdjudicationCache(scope([outputFrom(EMB_365, [pairId])], EMB_365));
    expect(lookupWorkflowAdjudication(cache, pairId, WORKFLOW_ADJUDICATION_PROMPT_VERSION, MODEL)).toBeDefined();
  });

  it("would otherwise collide: the raw key is identical across windows", () => {
    const pairId = workflowPairId("1700000001.000100", "1700000002.000100");
    const unscoped = buildWorkflowAdjudicationCache([outputFrom(EMB_180, [pairId])]);
    // Demonstrates the hazard the scoping filter removes.
    expect(lookupWorkflowAdjudication(unscoped, pairId, WORKFLOW_ADJUDICATION_PROMPT_VERSION, MODEL)).toBeDefined();
  });

  it("filters by upstream artifact in the CLI before building the cache", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/cli/intelligence-workflow-adjudicate.ts", "utf8");
    expect(source).toContain("output.metadata.inputFile === resolvedInput.relativePath");
    const filterAt = source.indexOf("output.metadata.inputFile === resolvedInput.relativePath");
    const buildAt = source.indexOf("buildWorkflowAdjudicationCache(priorOutputs)");
    expect(filterAt).toBeGreaterThan(-1);
    expect(buildAt).toBeGreaterThan(filterAt);
  });
});
