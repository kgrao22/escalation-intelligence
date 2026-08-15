import { describe, expect, it, vi } from "vitest";
import { parseWorkflowRecommendArgs } from "../src/cli/workflowRecommendArgs.js";
import {
  buildWorkflowRecommendationUserPrompt,
  WORKFLOW_RECOMMENDATION_SYSTEM_PROMPT,
} from "../src/llm/prompts/workflowRecommendation.js";
import { WorkflowRecommendationLLMOutputSchema } from "../src/llm/schemas/workflowRecommendation.js";
import type { StructuredParseFn } from "../src/llm/structuredParse.js";
import type { ExtractionOutput } from "../src/persistence/extractionOutput.js";
import { workflowRecommendationOutputFilePath } from "../src/persistence/workflowRecommendationOutput.js";
import type { WorkflowCluster } from "../src/workflow/buildWorkflowClusters.js";
import {
  buildClusterEvidence,
  buildRecommendationPayload,
  runWorkflowRecommendation,
} from "../src/workflow/runWorkflowRecommendation.js";
import {
  buildCustomerImpactIndex,
  frequencyScore,
  manualBurdenScore,
  MIN_OCCURRENCES_FOR_RANKING,
  rankClusters,
  recencyScore,
  scoreCluster,
  SCORING_WEIGHTS,
  selectRankableClusters,
} from "../src/workflow/workflowScoring.js";

const ASOF = new Date("2026-08-14T00:00:00.000Z");
const NO_IMPACT = new Map<string, string>();

function cluster(overrides: Partial<WorkflowCluster> = {}): WorkflowCluster {
  const memberRootTs = overrides.memberRootTs ?? ["1771293316.780129", "1772430420.146489"];
  return {
    clusterId: `wf-${memberRootTs[0]}`,
    occurrenceCount: memberRootTs.length,
    memberRootTs,
    workflowClassifications: ["customer_identity_update"],
    dominantWorkflowClassification: "customer_identity_update",
    automationStatusBreakdown: { manual: memberRootTs.length },
    technicalWorkflowCount: 0,
    workflowOnlyCount: memberRootTs.length,
    firstSeen: "2026-02-17T00:00:00.000Z",
    lastSeen: "2026-08-12T00:00:00.000Z",
    representativeWorkflowStatement: "Update a customer's email address across backend systems.",
    representativeRootTs: memberRootTs[0] as string,
    samplePermalinks: memberRootTs.map((ts) => `https://example.slack.com/archives/C1/p${ts}`),
    relatedClusterIds: [],
    internalSameEdgeCount: 1,
    ...overrides,
  };
}

function members(count: number, prefix = "17700000"): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(2, "0")}.000100`);
}

describe("eligibility", () => {
  it("excludes singletons from the ranking", () => {
    const clusters = [
      cluster({ memberRootTs: members(3), clusterId: "wf-a" }),
      cluster({ memberRootTs: ["1771293316.780129"], clusterId: "wf-single" }),
    ];
    const rankable = selectRankableClusters(clusters);
    expect(rankable).toHaveLength(1);
    expect(rankable[0]?.clusterId).toBe("wf-a");
    expect(rankClusters(clusters, NO_IMPACT, ASOF).map((s) => s.cluster.clusterId)).toEqual(["wf-a"]);
  });

  it("includes a cluster at exactly the minimum occurrence count", () => {
    expect(MIN_OCCURRENCES_FOR_RANKING).toBe(2);
    expect(selectRankableClusters([cluster({ memberRootTs: members(2) })])).toHaveLength(1);
  });
});

describe("scoring is deterministic and bounded", () => {
  it("produces an identical score for identical input", () => {
    const c = cluster();
    expect(scoreCluster(c, NO_IMPACT, ASOF)).toEqual(scoreCluster(c, NO_IMPACT, ASOF));
  });

  it("keeps every base score within 0-100", () => {
    const extremes = [
      cluster({ memberRootTs: members(60), automationStatusBreakdown: { manual: 60 }, technicalWorkflowCount: 60 }),
      cluster({
        memberRootTs: members(2),
        automationStatusBreakdown: { already_automated: 2 },
        technicalWorkflowCount: 0,
        lastSeen: "2020-01-01T00:00:00.000Z",
        firstSeen: "2020-01-01T00:00:00.000Z",
        workflowClassifications: ["other_operational_workflow"],
      }),
    ];
    for (const c of extremes) {
      const { baseScore } = scoreCluster(c, NO_IMPACT, ASOF);
      expect(baseScore).toBeGreaterThanOrEqual(0);
      expect(baseScore).toBeLessThanOrEqual(100);
    }
  });

  it("keeps every sub-factor within 0-100 and weights summing to 100", () => {
    const { scoringBreakdown } = scoreCluster(cluster(), NO_IMPACT, ASOF);
    let weightTotal = 0;
    for (const factor of Object.values(scoringBreakdown.factors)) {
      expect(factor.raw).toBeGreaterThanOrEqual(0);
      expect(factor.raw).toBeLessThanOrEqual(100);
      weightTotal += factor.weight;
    }
    expect(weightTotal).toBe(100);
    expect(Object.values(SCORING_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("records the formula alongside the numbers so a score is auditable alone", () => {
    const { scoringBreakdown } = scoreCluster(cluster(), NO_IMPACT, ASOF);
    expect(scoringBreakdown.formula).toContain("0.30*frequency");
    expect(scoringBreakdown.formula).toContain("0.25*manualBurden");
  });
});

describe("factor behaviour", () => {
  it("increases the score as frequency rises, all else equal", () => {
    const small = scoreCluster(cluster({ memberRootTs: members(2) }), NO_IMPACT, ASOF);
    const large = scoreCluster(cluster({ memberRootTs: members(20) }), NO_IMPACT, ASOF);
    expect(large.baseScore).toBeGreaterThan(small.baseScore);
    expect(frequencyScore(20)).toBeGreaterThan(frequencyScore(2));
  });

  it("saturates frequency rather than letting it run away", () => {
    expect(frequencyScore(40) - frequencyScore(30)).toBeLessThan(frequencyScore(4) - frequencyScore(2));
    expect(frequencyScore(1000)).toBeLessThanOrEqual(100);
  });

  it("increases the score as work becomes more manual", () => {
    const manual = scoreCluster(cluster({ automationStatusBreakdown: { manual: 2 } }), NO_IMPACT, ASOF);
    const mixed = scoreCluster(
      cluster({ automationStatusBreakdown: { manual: 1, partially_automated: 1 } }),
      NO_IMPACT,
      ASOF,
    );
    expect(manual.baseScore).toBeGreaterThan(mixed.baseScore);
  });

  it("lowers burden when the work is already automated", () => {
    expect(manualBurdenScore({ manual: 4 })).toBeGreaterThan(manualBurdenScore({ already_automated: 4 }));
    expect(manualBurdenScore({ already_automated: 4 })).toBeLessThan(manualBurdenScore({ unknown: 4 }));
    const automated = scoreCluster(cluster({ automationStatusBreakdown: { already_automated: 2 } }), NO_IMPACT, ASOF);
    const manual = scoreCluster(cluster({ automationStatusBreakdown: { manual: 2 } }), NO_IMPACT, ASOF);
    expect(automated.baseScore).toBeLessThan(manual.baseScore);
  });

  it("decays recency with age and floors it for stale work", () => {
    expect(recencyScore("2026-08-12T00:00:00.000Z", ASOF)).toBe(100);
    expect(recencyScore("2026-05-14T00:00:00.000Z", ASOF)).toBeLessThan(100);
    expect(recencyScore("2025-01-01T00:00:00.000Z", ASOF)).toBe(0);
    expect(recencyScore(null, ASOF)).toBe(0);
  });

  it("rates a coherent bounded workflow as more ready than a sprawling repair one", () => {
    const bounded = scoreCluster(cluster({ workflowClassifications: ["policy_state_change"] }), NO_IMPACT, ASOF);
    const sprawling = scoreCluster(
      cluster({
        workflowClassifications: ["manual_backend_correction", "other_operational_workflow", "manual_reconciliation"],
      }),
      NO_IMPACT,
      ASOF,
    );
    expect(bounded.scoringBreakdown.factors.automationReadiness.raw).toBeGreaterThan(
      sprawling.scoringBreakdown.factors.automationReadiness.raw,
    );
  });

  it("treats customer impact as neutral without evidence rather than inventing it", () => {
    const { scoringBreakdown } = scoreCluster(cluster(), NO_IMPACT, ASOF);
    expect(scoringBreakdown.factors.customerImpact.raw).toBe(50);
    expect(scoringBreakdown.customerImpactEvidenceCount).toBe(0);
  });

  it("uses extraction evidence for impact when available", () => {
    const roots = members(2);
    const impact = new Map([
      [roots[0] as string, "multiple_customers"],
      [roots[1] as string, "multiple_customers"],
    ]);
    const scored = scoreCluster(cluster({ memberRootTs: roots }), impact, ASOF);
    expect(scored.scoringBreakdown.factors.customerImpact.raw).toBe(100);
    expect(scored.scoringBreakdown.customerImpactEvidenceCount).toBe(2);
  });
});

describe("deterministic ordering", () => {
  const clusters = [
    cluster({ clusterId: "wf-small", memberRootTs: members(2, "17710000") }),
    cluster({ clusterId: "wf-big", memberRootTs: members(20, "17720000") }),
    cluster({ clusterId: "wf-mid", memberRootTs: members(4, "17730000") }),
  ];

  it("ranks by base score descending", () => {
    const ranked = rankClusters(clusters, NO_IMPACT, ASOF);
    for (let i = 0; i < ranked.length - 1; i++) {
      expect(ranked[i]!.baseScore).toBeGreaterThanOrEqual(ranked[i + 1]!.baseScore);
    }
    expect(ranked[0]?.cluster.occurrenceCount).toBe(20);
  });

  it("is invariant to input ordering", () => {
    const forward = rankClusters(clusters, NO_IMPACT, ASOF).map((s) => s.cluster.clusterId);
    const reversed = rankClusters([...clusters].reverse(), NO_IMPACT, ASOF).map((s) => s.cluster.clusterId);
    expect(reversed).toEqual(forward);
  });

  it("breaks exact ties deterministically on cluster id", () => {
    const twins = [
      cluster({ clusterId: "wf-zzz", memberRootTs: members(3, "17740000") }),
      cluster({ clusterId: "wf-aaa", memberRootTs: members(3, "17750000") }),
    ];
    const ranked = rankClusters(twins, NO_IMPACT, ASOF);
    expect(ranked[0]!.baseScore).toBe(ranked[1]!.baseScore);
    expect(ranked.map((s) => s.cluster.clusterId)).toEqual(["wf-aaa", "wf-zzz"]);
  });
});

function extractionOf(rootTsList: string[]): ExtractionOutput {
  return {
    metadata: {
      inputFile: "x", analysedAt: "2026-08-12T00:00:00.000Z", promptVersion: "v3",
      model: "claude-haiku-4-5", threadsAvailable: rootTsList.length, threadsAnalysed: rootTsList.length,
      technicalEscalations: 0, nonTechnical: rootTsList.length, failedExtractions: 0,
    },
    results: rootTsList.map((rootTs, i) => ({
      rootTs,
      status: "success" as const,
      analysis: {
        rootTs, permalink: `https://example.slack.com/archives/C1/p${rootTs}`,
        isTechnicalEscalation: false, classification: "operational_request",
        normalizedProblemStatement: null, affectedSystem: null, issueTypeHint: null,
        severity: "low", customerImpact: "single_customer", suspectedRootCause: null,
        rootCauseConfidence: null, resolutionStatus: "resolved", resolutionSummary: null,
        isRecurringEvidenceInThread: false, automationCandidate: "process_automation",
        automationReasoning: null, confidence: 0.9, isAutomationWorkflowCandidate: true,
        workflowClassification: "customer_identity_update",
        normalizedWorkflowStatement: `Member statement ${i}.`, automationStatus: "manual",
      },
    })),
  };
}

describe("privacy payload", () => {
  const roots = members(3);
  const extraction = extractionOf(roots);
  const evidence = buildClusterEvidence(extraction);
  const scored = scoreCluster(cluster({ memberRootTs: roots }), buildCustomerImpactIndex(extraction), ASOF);
  const payload = buildRecommendationPayload(scored, evidence);

  it("carries no permalink, rootTs, base score, or rank", () => {
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("slack.com");
    for (const rootTs of roots) {
      expect(serialized).not.toContain(rootTs);
    }
    expect(payload).not.toHaveProperty("baseScore");
    expect(payload).not.toHaveProperty("rank");
    expect(payload).not.toHaveProperty("samplePermalinks");
    expect(payload).not.toHaveProperty("memberRootTs");
  });

  it("renders a prompt free of identifiers", () => {
    const prompt = buildWorkflowRecommendationUserPrompt(payload);
    expect(prompt).not.toContain("slack.com");
    for (const rootTs of roots) {
      expect(prompt).not.toContain(rootTs);
    }
    expect(prompt).toContain("Update a customer's email address across backend systems.");
  });

  it("sends nothing but the projection through the parse function", async () => {
    const seen: string[] = [];
    const parseFn: StructuredParseFn<unknown> = vi.fn(async ({ userPrompt, systemPrompt }) => {
      seen.push(userPrompt, systemPrompt);
      return { parsed_output: validRecommendation(), stop_reason: "end_turn" };
    });

    await runWorkflowRecommendation({ scored: [scored], evidence, parseFn, model: "claude-haiku-4-5" });
    const transmitted = seen.join("\n");
    expect(transmitted).not.toContain("slack.com");
    for (const rootTs of roots) {
      expect(transmitted).not.toContain(rootTs);
    }
  });

  it("instructs the model that it is not ranking or scoring", () => {
    const prompt = WORKFLOW_RECOMMENDATION_SYSTEM_PROMPT.toLowerCase();
    expect(prompt).toContain("you are not ranking clusters against each other");
    expect(prompt).toContain("not scoring them");
    // The quality bar from the milestone examples.
    expect(prompt).toContain("audit trail");
    expect(prompt).toContain("unrestricted state mutation");
    expect(prompt).toContain("extend or consolidate");
  });
});

function validRecommendation() {
  return {
    recommendedAction: "internal_admin_tool",
    automationPriority: "high",
    automationFeasibility: "medium",
    rationale: "Recurs often and is fully manual.",
    proposedAutomation: "A guarded identity-update operation.",
    risksOrGuardrails: ["Require role-based access", "Log every change"],
    expectedBenefit: "Removes recurring manual work.",
  };
}

describe("the LLM cannot influence score or rank", () => {
  const roots = members(2);
  const evidence = buildClusterEvidence(extractionOf(roots));

  it("rejects a response schema carrying a score or rank field", () => {
    // The schema has no such fields, so extra keys are simply not adopted.
    const parsed = WorkflowRecommendationLLMOutputSchema.parse({
      ...validRecommendation(),
      baseScore: 999,
      rank: 1,
    });
    expect(parsed).not.toHaveProperty("baseScore");
    expect(parsed).not.toHaveProperty("rank");
  });

  it("keeps the deterministic score and rank even when the model returns its own", async () => {
    const scoredList = rankClusters(
      [
        cluster({ clusterId: "wf-big", memberRootTs: members(20, "17720000") }),
        cluster({ clusterId: "wf-small", memberRootTs: members(2, "17710000") }),
      ],
      NO_IMPACT,
      ASOF,
    );
    const parseFn: StructuredParseFn<unknown> = vi.fn(async () => ({
      parsed_output: { ...validRecommendation(), baseScore: 1, rank: 99, automationPriority: "low" },
      stop_reason: "end_turn",
    }));

    const items = await runWorkflowRecommendation({
      scored: scoredList,
      evidence,
      parseFn,
      model: "claude-haiku-4-5",
    });

    expect(items.map((i) => i.rank)).toEqual([1, 2]);
    expect(items[0]?.clusterId).toBe("wf-big");
    expect(items[0]?.baseScore).toBe(scoredList[0]?.baseScore);
    expect(items[0]?.baseScore).not.toBe(1);
    // The qualitative priority is kept, but sits alongside the score.
    expect(items[0]?.automationPriority).toBe("low");
    expect(items[0]!.baseScore).toBeGreaterThan(items[1]!.baseScore);
  });

  it("records a failure without disturbing rank assignment", async () => {
    const scoredList = rankClusters([cluster({ memberRootTs: members(3) })], NO_IMPACT, ASOF);
    const parseFn: StructuredParseFn<unknown> = vi.fn(async () => ({
      parsed_output: { recommendedAction: "not_a_real_action" },
      stop_reason: "end_turn",
    }));
    const items = await runWorkflowRecommendation({
      scored: scoredList,
      evidence,
      parseFn,
      model: "claude-haiku-4-5",
      retryOptions: { maxAttempts: 1, baseDelayMs: 0 },
    });
    expect(items[0]?.status).toBe("failed");
    expect(items[0]?.rank).toBe(1);
    expect(items[0]?.baseScore).toBe(scoredList[0]?.baseScore);
  });
});

describe("local metadata reattachment", () => {
  it("restores permalinks and member rootTs after the model responds", async () => {
    const roots = members(3);
    const c = cluster({ memberRootTs: roots });
    const evidence = buildClusterEvidence(extractionOf(roots));
    const scoredList = rankClusters([c], NO_IMPACT, ASOF);
    const parseFn: StructuredParseFn<unknown> = vi.fn(async () => ({
      parsed_output: validRecommendation(),
      stop_reason: "end_turn",
    }));

    const items = await runWorkflowRecommendation({
      scored: scoredList,
      evidence,
      parseFn,
      model: "claude-haiku-4-5",
    });

    expect(items[0]?.samplePermalinks).toEqual(c.samplePermalinks);
    expect(items[0]?.samplePermalinks[0]).toContain("slack.com");
    expect(items[0]?.memberRootTs).toEqual(roots);
    expect(items[0]?.recommendedAction).toBe("internal_admin_tool");
  });
});

describe("CLI args and output path", () => {
  it("defaults to auto-resolved inputs, no limit, dry run off", () => {
    expect(parseWorkflowRecommendArgs([])).toEqual({
      input: undefined, extractions: undefined, dryRun: false, limit: undefined,
    });
  });

  it("parses --input, --extractions, --dry-run, and --limit", () => {
    expect(parseWorkflowRecommendArgs(["--input=c.json", "--extractions=e.json", "--dry-run", "--limit=3"])).toEqual({
      input: "c.json", extractions: "e.json", dryRun: true, limit: 3,
    });
  });

  it("rejects an invalid --limit", () => {
    expect(() => parseWorkflowRecommendArgs(["--limit=0"])).toThrow(/Invalid --limit/);
  });

  it("writes to a workflow-specific filename", () => {
    expect(workflowRecommendationOutputFilePath("/d", new Date("2026-08-14T00:00:00.000Z"), "180d")).toContain(
      "workflow-recommendations-180d-2026-08-14.json",
    );
  });

  it("keeps the dry-run branch ahead of client construction", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/cli/intelligence-workflow-recommend.ts", "utf8");
    const dryRunAt = source.indexOf("if (args.dryRun)");
    const clientAt = source.indexOf("new Anthropic(");
    expect(dryRunAt).toBeGreaterThan(-1);
    expect(clientAt).toBeGreaterThan(dryRunAt);
    expect(source.slice(dryRunAt, clientAt)).toContain("Zero Anthropic API calls made");
  });
});
