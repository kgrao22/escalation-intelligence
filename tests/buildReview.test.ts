import { describe, expect, it } from "vitest";
import { parseReviewBuilderArgs } from "../src/cli/reviewBuilderArgs.js";
import type { ExtractionOutput, ExtractionResultItem } from "../src/persistence/extractionOutput.js";
import type { ReportOutput } from "../src/persistence/reportOutput.js";
import { reviewArtifactFilePath } from "../src/persistence/reviewArtifactOutput.js";
import type { WorkflowClusterOutput } from "../src/persistence/workflowClusterOutput.js";
import type { WorkflowRecommendationOutput } from "../src/persistence/workflowRecommendationOutput.js";
import type { WorkflowCluster } from "../src/workflow/buildWorkflowClusters.js";
import {
  buildReview,
  MAX_EVIDENCE_LINKS,
  ReviewIntegrityError,
  validateReviewInputs,
} from "../src/review/buildReview.js";
import { deriveWorkflowTitle, workflowClassificationDisplayName } from "../src/review/displayNames.js";
import { renderReview } from "../src/review/renderReview.js";

const LINKS = Array.from({ length: 6 }, (_, i) => `https://example.slack.com/archives/C1/p17700000${i}`);

function cluster(overrides: Partial<WorkflowCluster> = {}): WorkflowCluster {
  const memberRootTs = overrides.memberRootTs ?? ["1770000000.0001", "1770000001.0001"];
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
    representativeWorkflowStatement: "Update a customer's email address across multiple backend systems.",
    representativeRootTs: memberRootTs[0] as string,
    samplePermalinks: LINKS,
    relatedClusterIds: [],
    internalSameEdgeCount: 1,
    ...overrides,
  };
}

function clustersOutput(clusters: WorkflowCluster[], sourceWindowDays = 180): WorkflowClusterOutput {
  return {
    metadata: {
      extractionsInputFile: "e.json", adjudicationsInputFile: "a.json",
      generatedAt: "2026-08-13T00:00:00.000Z", sourceWindowDays,
      clusteringAlgorithm: "connected_components_over_same_underlying_workflow_edges",
      clusterIdScheme: "wf-<lexicographically-smallest-member-rootTs>",
      totalWorkflowCandidates: clusters.reduce((n, c) => n + c.occurrenceCount, 0),
      totalClusters: clusters.length,
      recurringClusters: clusters.filter((c) => c.occurrenceCount >= 2).length,
      singletonClusters: clusters.filter((c) => c.occurrenceCount < 2).length,
      largestClusterSize: Math.max(...clusters.map((c) => c.occurrenceCount), 0),
      sameEdges: 1, relatedEdges: 0, differentEdges: 0, danglingSameEdges: 0,
      adjudicationModel: "claude-haiku-4-5", adjudicationPromptVersion: "v2", category: "workflow",
    },
    clusters,
  };
}

function recommendationsOutput(
  clusters: WorkflowCluster[],
  sourceWindowDays = 180,
): WorkflowRecommendationOutput {
  const recurring = clusters.filter((c) => c.occurrenceCount >= 2);
  return {
    metadata: {
      inputFile: "c.json", createdAt: "2026-08-13T00:00:00.000Z", sourceWindowDays,
      model: "claude-haiku-4-5", promptVersion: "v1", scoringFormula: "f", scoringWeights: {},
      minOccurrencesForRanking: 2, totalClusters: clusters.length, rankedClusters: recurring.length,
      recommended: recurring.length, failed: 0, category: "workflow",
    },
    recommendations: recurring.map((c, i) => ({
      rank: i + 1,
      clusterId: c.clusterId,
      occurrenceCount: c.occurrenceCount,
      representativeWorkflowStatement: c.representativeWorkflowStatement,
      baseScore: 90 - i * 10,
      scoringBreakdown: {
        factors: {} as never, formula: "f", customerImpactEvidenceCount: 0,
        daysSinceLastSeen: 2, spanDays: 176,
      },
      dominantWorkflowClassification: c.dominantWorkflowClassification,
      automationStatusBreakdown: c.automationStatusBreakdown,
      firstSeen: c.firstSeen, lastSeen: c.lastSeen,
      memberRootTs: c.memberRootTs, samplePermalinks: c.samplePermalinks,
      relatedClusterIds: [], status: "success" as const,
      recommendedAction: "internal_admin_tool" as const,
      automationPriority: "high" as const,
      automationFeasibility: "high" as const,
      rationale: "Recurs often.", proposedAutomation: "Build a guarded tool.",
      risksOrGuardrails: ["Role-based access"], expectedBenefit: "Less manual work.",
    })),
    longTail: { singletonWorkflowCount: clusters.length - recurring.length, byClassification: {} },
  };
}

function extractionOutput(sourceWindowDays = 180): ExtractionOutput {
  const make = (rootTs: string, technical: boolean, workflow: boolean): ExtractionResultItem => ({
    rootTs,
    status: "success" as const,
    analysis: {
      rootTs, permalink: `https://slack.example/p${rootTs}`,
      isTechnicalEscalation: technical,
      classification: technical ? ("technical_defect" as const) : ("operational_request" as const),
      normalizedProblemStatement: technical ? "Something broke." : null,
      affectedSystem: null, issueTypeHint: null, severity: "low",
      customerImpact: "single_customer", suspectedRootCause: null, rootCauseConfidence: null,
      resolutionStatus: "resolved", resolutionSummary: null, isRecurringEvidenceInThread: false,
      automationCandidate: "process_automation", automationReasoning: null, confidence: 0.9,
      isAutomationWorkflowCandidate: workflow,
      workflowClassification: workflow ? "customer_identity_update" : null,
      normalizedWorkflowStatement: workflow ? "Do the manual thing." : null,
      automationStatus: "manual",
    },
  });

  // 2 technical-only, 3 workflow-only, 4 both, 1 neither = 10 threads.
  const results = [
    make("1.1", true, false), make("1.2", true, false),
    make("2.1", false, true), make("2.2", false, true), make("2.3", false, true),
    make("3.1", true, true), make("3.2", true, true), make("3.3", true, true), make("3.4", true, true),
    make("4.1", false, false),
  ];

  return {
    metadata: {
      inputFile: "s.json", analysedAt: "2026-08-12T00:00:00.000Z", promptVersion: "v3",
      model: "claude-haiku-4-5", threadsAvailable: results.length, threadsAnalysed: results.length,
      technicalEscalations: 6, nonTechnical: 4, failedExtractions: 0, sourceWindowDays,
    },
    results,
  };
}

function technicalReport(sourceWindowDays: number): ReportOutput {
  return {
    metadata: {
      groupsInputFile: "g.json", createdAt: "2026-08-11T00:00:00.000Z", asOf: "2026-08-11T00:00:00.000Z",
      sourceWindowDays, adjudicationModel: "claude-haiku-4-5", adjudicationPromptVersion: "v1",
      candidateSimilarityFloor: 0.6,
    },
    report: {
      summary: {
        recurringIssueCount: 1, totalOccurrences: 3, issuesWithOpenOccurrences: 1,
        totalOpenOccurrences: 2, issuesNeedingReview: 0, largestGroupSize: 3,
        severityDistribution: [], customerImpactDistribution: [], resolutionStatusDistribution: [],
        earliestOccurrence: null, latestOccurrence: null,
      },
      rankingCriteria: [],
      issues: [
        {
          rank: 1, groupId: "g1", name: "Invoice tax miscalculation", alternateNames: [],
          occurrenceCount: 3, consistency: "fully_confirmed", needsReview: false,
          window: { firstSeen: null, lastSeen: null, spanDays: null, averageDaysBetweenOccurrences: null, daysSinceLastOccurrence: null },
          severityDistribution: [], customerImpactDistribution: [], resolutionStatusDistribution: [],
          peakSeverity: "high", peakCustomerImpact: "single_customer",
          affectedSystems: ["billing-service"],
          resolution: {
            unresolvedCount: 2, workaroundCount: 0, resolvedCount: 1, openCount: 2,
            hasUnresolvedOccurrences: true, hasWorkaroundOccurrences: false,
            hasOpenOccurrences: true, fullyResolved: false,
          },
          averageSameEdgeConfidence: 0.9, minimumSameEdgeConfidence: 0.8, averageSameEdgeSimilarity: 0.8,
          rankingSignals: {
            occurrenceCount: 3, openCount: 2, peakSeverityRank: 2,
            peakCustomerImpactRank: 1, lastSeenAt: 0,
          },
          occurrences: [
            { rootTs: "9.1", postedAt: null, permalink: "https://slack.example/t1", normalizedProblemStatement: "x", severity: "high", customerImpact: "single_customer", resolutionStatus: "unresolved", affectedSystem: "billing-service", suspectedRootCause: null, resolutionSummary: null },
          ],
        },
      ],
    },
  };
}

const recurring = cluster({ memberRootTs: ["1770000000.0001", "1770000001.0001", "1770000002.0001"] });
const singleton = cluster({
  memberRootTs: ["1780000000.0001"],
  clusterId: "wf-1780000000.0001",
  dominantWorkflowClassification: "manual_backend_correction",
  workflowClassifications: ["manual_backend_correction"],
});
const ALL_CLUSTERS = [recurring, singleton];

function baseParams(overrides: Partial<Parameters<typeof buildReview>[0]> = {}) {
  return {
    windowTag: "180d",
    extraction: extractionOutput(),
    clusters: clustersOutput(ALL_CLUSTERS),
    recommendations: recommendationsOutput(ALL_CLUSTERS),
    ...overrides,
  };
}

describe("window matching", () => {
  it("accepts inputs whose window matches the review window", () => {
    expect(() => validateReviewInputs(baseParams())).not.toThrow();
  });

  it("rejects an extraction file from a different window", () => {
    expect(() => validateReviewInputs(baseParams({ extraction: extractionOutput(90) }))).toThrow(
      /covers 90 days but the review window is 180d/,
    );
  });

  it("rejects a 90-day technical report in a 180-day review", () => {
    expect(() => validateReviewInputs(baseParams({ technicalReport: technicalReport(90) }))).toThrow(
      ReviewIntegrityError,
    );
    expect(() => validateReviewInputs(baseParams({ technicalReport: technicalReport(90) }))).toThrow(
      /Run the technical pipeline for this window/,
    );
  });

  it("accepts a technical report from the matching window", () => {
    expect(() => validateReviewInputs(baseParams({ technicalReport: technicalReport(180) }))).not.toThrow();
  });
});

describe("missing technical recurrence", () => {
  it("is handled gracefully and stated explicitly", () => {
    const review = buildReview(baseParams());
    expect(review.technicalIssues.available).toBe(false);
    expect(review.technicalIssues.issues).toEqual([]);
    expect(review.technicalIssues.message).toContain("has not yet been generated for the full 180d window");
    expect(review.technicalIssues.message).toContain("workflow intelligence below is complete");
  });

  it("leaves the workflow sections fully populated", () => {
    const review = buildReview(baseParams());
    expect(review.automationOpportunities.length).toBeGreaterThan(0);
    expect(review.recurringWorkflows.length).toBeGreaterThan(0);
  });

  it("adds a next action to run the technical pipeline", () => {
    const review = buildReview(baseParams());
    expect(review.nextActions.at(-1)?.action).toContain("Run the technical recurrence pipeline");
  });

  it("renders the technical section as a pending notice, never as data", () => {
    const rendered = renderReview(buildReview(baseParams()));
    const reply = rendered.slackMrkdwn.replies[2];
    expect(reply?.title).toBe("Recurring technical issues");
    expect(reply?.text).toContain("has not yet been generated");
  });

  it("shows real issues when a matching report is supplied", () => {
    const review = buildReview(baseParams({ technicalReport: technicalReport(180) }));
    expect(review.technicalIssues.available).toBe(true);
    expect(review.technicalIssues.issues[0]?.name).toBe("Invoice tax miscalculation");
    expect(review.technicalIssues.issues[0]?.openOccurrences).toBe(2);
  });
});

describe("integrity checks", () => {
  it("rejects a recommendation for an unknown cluster", () => {
    const recommendations = recommendationsOutput(ALL_CLUSTERS);
    recommendations.recommendations[0]!.clusterId = "wf-does-not-exist";
    expect(() => validateReviewInputs(baseParams({ recommendations }))).toThrow(/unknown cluster/);
  });

  it("rejects disagreeing occurrence counts", () => {
    const recommendations = recommendationsOutput(ALL_CLUSTERS);
    recommendations.recommendations[0]!.occurrenceCount = 99;
    expect(() => validateReviewInputs(baseParams({ recommendations }))).toThrow(/occurrence count disagrees/);
  });

  it("rejects non-contiguous ranks", () => {
    const recommendations = recommendationsOutput(ALL_CLUSTERS);
    recommendations.recommendations[0]!.rank = 5;
    expect(() => validateReviewInputs(baseParams({ recommendations }))).toThrow(/not contiguous/);
  });

  it("rejects duplicate ranks", () => {
    const two = [recurring, cluster({ memberRootTs: ["1790000000.0001", "1790000001.0001"], clusterId: "wf-b" })];
    const recommendations = recommendationsOutput(two);
    recommendations.recommendations[1]!.rank = 1;
    expect(() => validateReviewInputs(baseParams({ clusters: clustersOutput(two), recommendations }))).toThrow(
      /not unique/,
    );
  });

  it("rejects evidence links that do not belong to the cluster", () => {
    const recommendations = recommendationsOutput(ALL_CLUSTERS);
    recommendations.recommendations[0]!.samplePermalinks = ["https://slack.example/not-mine"];
    expect(() => validateReviewInputs(baseParams({ recommendations }))).toThrow(/not belonging to its cluster/);
  });
});

describe("overview counting", () => {
  const review = buildReview(baseParams());

  it("does not double-count technical + workflow threads", () => {
    const { overview } = review;
    expect(overview.technicalOnly).toBe(2);
    expect(overview.workflowOnly).toBe(3);
    expect(overview.technicalAndWorkflow).toBe(4);
    expect(overview.neither).toBe(1);
    // Union of the two tracks, counted once — not technical + workflow (10).
    expect(overview.distinctActionableThreads).toBe(9);
    expect(overview.technicalEscalations + overview.workflowCandidates).toBe(13);
  });

  it("reports the buckets as a partition of analysed threads", () => {
    const { overview } = review;
    expect(
      overview.technicalOnly + overview.workflowOnly + overview.technicalAndWorkflow + overview.neither,
    ).toBe(overview.threadsAnalysed);
  });

  it("counts recurring clusters and singletons correctly", () => {
    expect(review.overview.recurringWorkflowClusters).toBe(1);
    expect(review.overview.singletonWorkflows).toBe(1);
    expect(review.longTail.singletonWorkflowCount).toBe(1);
  });
});

describe("automation opportunities preserve rank and score", () => {
  it("keeps the artifact's rank and score untouched and in order", () => {
    const two = [recurring, cluster({ memberRootTs: ["1790000000.0001", "1790000001.0001"], clusterId: "wf-b" })];
    const recommendations = recommendationsOutput(two);
    const review = buildReview(baseParams({ clusters: clustersOutput(two), recommendations }));

    expect(review.automationOpportunities.map((o) => o.rank)).toEqual([1, 2]);
    expect(review.automationOpportunities[0]?.score).toBe(90);
    expect(review.automationOpportunities[1]?.score).toBe(80);
  });

  it("excludes singletons from the opportunity list", () => {
    const review = buildReview(baseParams());
    expect(review.automationOpportunities.map((o) => o.clusterId)).not.toContain(singleton.clusterId);
  });

  it("limits evidence links per item", () => {
    const review = buildReview(baseParams());
    expect(LINKS.length).toBeGreaterThan(MAX_EVIDENCE_LINKS);
    expect(review.automationOpportunities[0]?.evidenceLinks).toHaveLength(MAX_EVIDENCE_LINKS);
    expect(review.recurringWorkflows[0]?.evidenceLinks).toHaveLength(MAX_EVIDENCE_LINKS);
  });
});

describe("display names are deterministic", () => {
  it("maps known classifications to readable labels", () => {
    expect(workflowClassificationDisplayName("customer_identity_update")).toBe("Customer identity & email updates");
    expect(workflowClassificationDisplayName("policy_state_change")).toBe("Policy lifecycle management");
    expect(workflowClassificationDisplayName("manual_backend_correction")).toBe("Backend operational corrections");
  });

  it("humanises an unknown classification rather than showing snake_case", () => {
    expect(workflowClassificationDisplayName("some_new_thing")).toBe("Some new thing");
    expect(workflowClassificationDisplayName(null)).toBe("Uncategorised operational work");
  });

  it("derives the same title every time from the same input", () => {
    const args = ["customer_identity_update", "Update a customer's email address across systems."] as const;
    expect(deriveWorkflowTitle(...args)).toBe(deriveWorkflowTitle(...args));
  });

  it("never ends a truncated title on a dangling function word", () => {
    const title = deriveWorkflowTitle(
      "policy_state_change",
      "Manually reactivate a cancelled policy or program back to active state after payment.",
    );
    expect(title).not.toMatch(/\b(to|back|across|for|the|and|of)…$/);
    expect(title).toContain("Policy lifecycle management");
  });

  it("falls back to the label alone when no usable phrase exists", () => {
    expect(deriveWorkflowTitle("policy_cancellation", "Cancel.")).toBe("Policy cancellation");
  });
});

describe("next actions are deterministic", () => {
  it("derives actions from recorded recommendations, not free text", () => {
    const review = buildReview(baseParams());
    expect(review.nextActions[0]?.action).toMatch(/^Build an internal admin tool for /);
    expect(review.nextActions[0]?.basis).toContain("occurrences");
  });

  it("produces identical actions for identical inputs", () => {
    expect(buildReview(baseParams()).nextActions).toEqual(buildReview(baseParams()).nextActions);
  });

  it("numbers actions contiguously from 1", () => {
    const review = buildReview(baseParams());
    expect(review.nextActions.map((a) => a.order)).toEqual(review.nextActions.map((_, i) => i + 1));
  });
});

describe("rendering", () => {
  const rendered = renderReview(buildReview(baseParams()));

  it("produces one overview message and four thread replies", () => {
    expect(rendered.slackMrkdwn.replies).toHaveLength(4);
    expect(rendered.slackMrkdwn.replies.map((r) => r.title)).toEqual([
      "Automation opportunities",
      "Recurring manual workflows",
      "Recurring technical issues",
      "Recommended next actions",
    ]);
  });

  it("uses Slack mrkdwn conventions in the overview", () => {
    expect(rendered.slackMrkdwn.overview).toContain("*Escalation Intelligence — 6 Month Review*");
    expect(rendered.slackMrkdwn.overview).toContain("• 10 escalation threads analysed");
  });

  it("keeps pipeline jargon out of the reader-facing output", () => {
    const all = [rendered.slackMrkdwn.overview, ...rendered.slackMrkdwn.replies.map((r) => r.text)]
      .join("\n")
      .toLowerCase();
    for (const jargon of [
      "cosine", "embedding", "adjudicat", "similarity", "candidate pair",
      "prompt", "claude", "voyage", "haiku", "vector", "baseScore".toLowerCase(),
      "scoring formula", "cluster id", "roottsz",
    ]) {
      expect(all, `leaked jargon: ${jargon}`).not.toContain(jargon);
    }
  });

  it("renders evidence links as Slack links", () => {
    expect(rendered.slackMrkdwn.replies[0]?.text).toMatch(/<https:\/\/example\.slack\.com[^|]+\|\d+>/);
  });

  it("produces plain text without mrkdwn markers", () => {
    expect(rendered.plainText).not.toContain("*");
    expect(rendered.plainText).toContain("Escalation Intelligence — 6 Month Review");
  });

  it("is byte-identical for identical inputs", () => {
    expect(renderReview(buildReview(baseParams()))).toEqual(rendered);
  });
});

describe("CLI args and output path", () => {
  it("defaults the window to 180d", () => {
    expect(parseReviewBuilderArgs([]).window).toBe("180d");
  });

  it("lets explicit paths override auto-resolution", () => {
    const args = parseReviewBuilderArgs([
      "--window=90d",
      "--workflow-recommendations=r.json",
      "--workflow-clusters=c.json",
      "--extractions=e.json",
      "--technical-report=t.json",
      "--dry-run",
    ]);
    expect(args).toEqual({
      window: "90d", workflowRecommendations: "r.json", workflowClusters: "c.json",
      extractions: "e.json", technicalReport: "t.json", dryRun: true,
    });
  });

  it("rejects a malformed window", () => {
    expect(() => parseReviewBuilderArgs(["--window=6months"])).toThrow(/Invalid --window/);
  });

  it("writes to a window-tagged review filename", () => {
    expect(reviewArtifactFilePath("/d", new Date("2026-08-13T00:00:00.000Z"), "180d")).toContain(
      "review-180d-2026-08-13.json",
    );
  });

  it("makes no external calls: the builder imports no API client", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const file of [
      "src/review/buildReview.ts",
      "src/review/renderReview.ts",
      "src/cli/intelligence-review-builder.ts",
    ]) {
      const source = await readFile(file, "utf8");
      expect(source).not.toContain("@slack/web-api");
      expect(source).not.toContain("@anthropic-ai/sdk");
      expect(source).not.toMatch(/chat\.postMessage/);
      expect(source).not.toContain("voyage");
    }
  });

  it("keeps the dry-run branch ahead of any file write", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/cli/intelligence-review-builder.ts", "utf8");
    const dryRunAt = source.indexOf("if (args.dryRun)");
    const writeAt = source.indexOf("writeReviewArtifact(artifact");
    expect(dryRunAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(dryRunAt);
    expect(source.slice(dryRunAt, writeAt)).toContain("No output file written");
  });
});
