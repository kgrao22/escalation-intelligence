import { describe, expect, it } from "vitest";
import { parseWorkflowClustersArgs } from "../src/cli/workflowClustersArgs.js";
import type { WorkflowAdjudicationResultItem } from "../src/persistence/workflowAdjudicationOutput.js";
import { workflowClusterOutputFilePath } from "../src/persistence/workflowClusterOutput.js";
import {
  assertClusterIntegrity,
  buildWorkflowClusters,
  WorkflowClusterIntegrityError,
  type WorkflowCluster,
} from "../src/workflow/buildWorkflowClusters.js";
import type { WorkflowEmbeddingCandidate } from "../src/workflow/workflowEmbeddingCandidates.js";
import { workflowPairId } from "../src/workflow/workflowCandidatePairs.js";

/** Synthetic only — no fixtures read from disk, no API calls anywhere. */
function candidate(
  rootTs: string,
  overrides: Partial<WorkflowEmbeddingCandidate> = {},
): WorkflowEmbeddingCandidate {
  return {
    rootTs,
    permalink: `https://slack.example/p${rootTs}`,
    statement: `Workflow statement for ${rootTs}.`,
    workflowClassification: "policy_state_change",
    automationStatus: "manual",
    isTechnicalEscalation: false,
    classification: "operational_request",
    affectedSystem: "policy-admin",
    resolutionStatus: "resolved",
    automationCandidate: "process_automation",
    nature: "workflow-only",
    ...overrides,
  };
}

function verdict(
  aRootTs: string,
  bRootTs: string,
  relationship: WorkflowAdjudicationResultItem["relationship"],
  overrides: Partial<WorkflowAdjudicationResultItem> = {},
): WorkflowAdjudicationResultItem {
  const a = candidate(aRootTs);
  const b = candidate(bRootTs);
  return {
    pairId: workflowPairId(aRootTs, bRootTs),
    similarity: 0.9,
    a: { rootTs: a.rootTs, permalink: a.permalink, normalizedWorkflowStatement: a.statement, workflowClassification: a.workflowClassification, automationStatus: a.automationStatus, nature: a.nature },
    b: { rootTs: b.rootTs, permalink: b.permalink, normalizedWorkflowStatement: b.statement, workflowClassification: b.workflowClassification, automationStatus: b.automationStatus, nature: b.nature },
    sameClassification: true,
    status: "success",
    relationship,
    confidence: 0.9,
    reasoning: "synthetic",
    proposedWorkflowName: relationship === "same_underlying_workflow" ? "A workflow" : null,
    ...overrides,
  };
}

const A = "1700000001.000100";
const B = "1700000002.000100";
const C = "1700000003.000100";
const D = "1700000004.000100";

function clusterFor(clusters: WorkflowCluster[], rootTs: string): WorkflowCluster {
  const found = clusters.find((cluster) => cluster.memberRootTs.includes(rootTs));
  if (!found) {
    throw new Error(`no cluster contains ${rootTs}`);
  }
  return found;
}

describe("connected components over SAME edges", () => {
  it("merges A-B and B-C transitively into one {A,B,C} cluster", () => {
    const { clusters } = buildWorkflowClusters(
      [candidate(A), candidate(B), candidate(C)],
      [verdict(A, B, "same_underlying_workflow"), verdict(B, C, "same_underlying_workflow")],
    );

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.memberRootTs).toEqual([A, B, C]);
    expect(clusters[0]?.occurrenceCount).toBe(3);
  });

  it("does NOT merge C when B-C is only RELATED", () => {
    const { clusters, stats } = buildWorkflowClusters(
      [candidate(A), candidate(B), candidate(C)],
      [verdict(A, B, "same_underlying_workflow"), verdict(B, C, "related_workflow_family")],
    );

    expect(clusters).toHaveLength(2);
    expect(clusterFor(clusters, A).memberRootTs).toEqual([A, B]);
    expect(clusterFor(clusters, C).memberRootTs).toEqual([C]);
    expect(stats.relatedEdges).toBe(1);
  });

  it("does NOT merge on a DIFFERENT verdict", () => {
    const { clusters } = buildWorkflowClusters(
      [candidate(A), candidate(B)],
      [verdict(A, B, "different")],
    );
    expect(clusters).toHaveLength(2);
  });

  it("ignores a failed adjudication entirely", () => {
    const { clusters } = buildWorkflowClusters(
      [candidate(A), candidate(B)],
      [verdict(A, B, undefined, { status: "failed", error: "boom", proposedWorkflowName: null })],
    );
    expect(clusters).toHaveLength(2);
  });

  it("never merges on classification or similarity alone", () => {
    // Same classification, very high similarity, but no SAME verdict.
    const { clusters } = buildWorkflowClusters(
      [candidate(A), candidate(B)],
      [verdict(A, B, "different", { similarity: 0.99, sameClassification: true })],
    );
    expect(clusters).toHaveLength(2);
  });

  it("counts a SAME edge naming an unknown thread as dangling instead of silently dropping it", () => {
    const { clusters, stats } = buildWorkflowClusters(
      [candidate(A), candidate(B)],
      [verdict(A, B, "same_underlying_workflow"), verdict(A, "9999999999.000100", "same_underlying_workflow")],
    );
    expect(stats.danglingSameEdges).toBe(1);
    expect(clusters).toHaveLength(1);
  });
});

describe("singletons and completeness", () => {
  it("preserves candidates with no SAME edge as singletons", () => {
    const { clusters, stats } = buildWorkflowClusters(
      [candidate(A), candidate(B), candidate(C), candidate(D)],
      [verdict(A, B, "same_underlying_workflow")],
    );

    expect(stats.totalClusters).toBe(3);
    expect(stats.recurringClusters).toBe(1);
    expect(stats.singletonClusters).toBe(2);
    expect(clusterFor(clusters, C).occurrenceCount).toBe(1);
  });

  it("places every candidate in exactly one cluster", () => {
    const candidates = [A, B, C, D].map((rootTs) => candidate(rootTs));
    const { clusters } = buildWorkflowClusters(candidates, [verdict(A, B, "same_underlying_workflow")]);

    const members = clusters.flatMap((cluster) => cluster.memberRootTs);
    expect(members).toHaveLength(candidates.length);
    expect(new Set(members).size).toBe(candidates.length);
  });

  it("clusters an adjudication-free dataset entirely into singletons", () => {
    const { stats } = buildWorkflowClusters([candidate(A), candidate(B)], []);
    expect(stats.singletonClusters).toBe(2);
    expect(stats.recurringClusters).toBe(0);
  });
});

describe("integrity checks fail loudly", () => {
  const candidates = [candidate(A), candidate(B)];

  it("rejects a member appearing in two clusters", () => {
    const duplicated: WorkflowCluster[] = [
      { ...emptyCluster("wf-1"), memberRootTs: [A, B], occurrenceCount: 2 },
      { ...emptyCluster("wf-2"), memberRootTs: [B], occurrenceCount: 1 },
    ];
    expect(() => assertClusterIntegrity(duplicated, candidates)).toThrow(WorkflowClusterIntegrityError);
    expect(() => assertClusterIntegrity(duplicated, candidates)).toThrow(/more than one cluster/);
  });

  it("rejects a candidate present in no cluster", () => {
    const incomplete: WorkflowCluster[] = [{ ...emptyCluster("wf-1"), memberRootTs: [A], occurrenceCount: 1 }];
    expect(() => assertClusterIntegrity(incomplete, candidates)).toThrow(/in no cluster/);
  });

  it("rejects a clustered rootTs that is not a candidate", () => {
    const extraneous: WorkflowCluster[] = [
      { ...emptyCluster("wf-1"), memberRootTs: [A, B, C], occurrenceCount: 3 },
    ];
    expect(() => assertClusterIntegrity(extraneous, candidates)).toThrow(/not workflow candidates/);
  });

  it("rejects an occurrenceCount that disagrees with the member list", () => {
    const wrongCount: WorkflowCluster[] = [
      { ...emptyCluster("wf-1"), memberRootTs: [A, B], occurrenceCount: 5 },
    ];
    expect(() => assertClusterIntegrity(wrongCount, candidates)).toThrow(/reports 5 occurrences/);
  });

  it("rejects duplicate rootTs in the candidate set itself", () => {
    expect(() => buildWorkflowClusters([candidate(A), candidate(A)], [])).toThrow(/duplicate rootTs/);
  });

  it("accepts a correct partition", () => {
    const valid: WorkflowCluster[] = [
      { ...emptyCluster("wf-1"), memberRootTs: [A], occurrenceCount: 1 },
      { ...emptyCluster("wf-2"), memberRootTs: [B], occurrenceCount: 1 },
    ];
    expect(() => assertClusterIntegrity(valid, candidates)).not.toThrow();
  });
});

function emptyCluster(clusterId: string): WorkflowCluster {
  return {
    clusterId, occurrenceCount: 0, memberRootTs: [], workflowClassifications: [],
    dominantWorkflowClassification: null, automationStatusBreakdown: {},
    technicalWorkflowCount: 0, workflowOnlyCount: 0, firstSeen: null, lastSeen: null,
    representativeWorkflowStatement: "", representativeRootTs: "", samplePermalinks: [],
    relatedClusterIds: [], internalSameEdgeCount: 0,
  };
}

describe("determinism", () => {
  const candidates = [D, B, A, C].map((rootTs) => candidate(rootTs));
  const edges = [verdict(B, C, "same_underlying_workflow"), verdict(A, B, "same_underlying_workflow")];

  it("derives cluster ids from the smallest member rootTs, not randomness", () => {
    const { clusters } = buildWorkflowClusters(candidates, edges);
    expect(clusterFor(clusters, A).clusterId).toBe(`wf-${A}`);
    expect(clusterFor(clusters, D).clusterId).toBe(`wf-${D}`);
  });

  it("produces identical output across repeated runs", () => {
    const first = buildWorkflowClusters(candidates, edges);
    const second = buildWorkflowClusters(candidates, edges);
    expect(second).toEqual(first);
  });

  it("is invariant to candidate and edge ordering", () => {
    const baseline = buildWorkflowClusters(candidates, edges);
    const shuffled = buildWorkflowClusters([...candidates].reverse(), [...edges].reverse());
    expect(shuffled.clusters).toEqual(baseline.clusters);
  });

  it("orders clusters by size descending, then by cluster id", () => {
    const { clusters } = buildWorkflowClusters(candidates, edges);
    for (let i = 0; i < clusters.length - 1; i++) {
      const left = clusters[i]!;
      const right = clusters[i + 1]!;
      expect(
        left.occurrenceCount > right.occurrenceCount ||
          (left.occurrenceCount === right.occurrenceCount && left.clusterId <= right.clusterId),
      ).toBe(true);
    }
  });
});

describe("representative statement selection", () => {
  it("picks the member with the most SAME edges inside the component", () => {
    // B is the hub: A-B, B-C, B-D.
    const { clusters } = buildWorkflowClusters(
      [A, B, C, D].map((rootTs) => candidate(rootTs, { statement: `Statement ${rootTs}` })),
      [
        verdict(A, B, "same_underlying_workflow"),
        verdict(B, C, "same_underlying_workflow"),
        verdict(B, D, "same_underlying_workflow"),
      ],
    );

    expect(clusters[0]?.representativeRootTs).toBe(B);
    expect(clusters[0]?.representativeWorkflowStatement).toBe(`Statement ${B}`);
  });

  it("breaks a degree tie on the lowest rootTs", () => {
    const { clusters } = buildWorkflowClusters(
      [candidate(A), candidate(B)],
      [verdict(A, B, "same_underlying_workflow")],
    );
    expect(clusters[0]?.representativeRootTs).toBe(A);
  });

  it("uses the member's own statement for a singleton", () => {
    const { clusters } = buildWorkflowClusters([candidate(A, { statement: "Only one." })], []);
    expect(clusters[0]?.representativeWorkflowStatement).toBe("Only one.");
  });

  it("never invents a statement, always reusing an existing one", () => {
    const statements = new Set([`Statement ${A}`, `Statement ${B}`]);
    const { clusters } = buildWorkflowClusters(
      [candidate(A, { statement: `Statement ${A}` }), candidate(B, { statement: `Statement ${B}` })],
      [verdict(A, B, "same_underlying_workflow")],
    );
    expect(statements.has(clusters[0]!.representativeWorkflowStatement)).toBe(true);
  });
});

describe("cluster metrics", () => {
  it("aggregates automation status across members", () => {
    const { clusters } = buildWorkflowClusters(
      [
        candidate(A, { automationStatus: "manual" }),
        candidate(B, { automationStatus: "manual" }),
        candidate(C, { automationStatus: "partially_automated" }),
      ],
      [verdict(A, B, "same_underlying_workflow"), verdict(B, C, "same_underlying_workflow")],
    );
    expect(clusters[0]?.automationStatusBreakdown).toEqual({ manual: 2, partially_automated: 1 });
  });

  it("counts technical+workflow and workflow-only separately", () => {
    const { clusters } = buildWorkflowClusters(
      [
        candidate(A, { nature: "technical+workflow", isTechnicalEscalation: true }),
        candidate(B, { nature: "workflow-only" }),
        candidate(C, { nature: "workflow-only" }),
      ],
      [verdict(A, B, "same_underlying_workflow"), verdict(B, C, "same_underlying_workflow")],
    );
    expect(clusters[0]?.technicalWorkflowCount).toBe(1);
    expect(clusters[0]?.workflowOnlyCount).toBe(2);
    expect(clusters[0]!.technicalWorkflowCount + clusters[0]!.workflowOnlyCount).toBe(3);
  });

  it("reports the dominant classification while listing every one spanned", () => {
    const { clusters } = buildWorkflowClusters(
      [
        candidate(A, { workflowClassification: "policy_state_change" }),
        candidate(B, { workflowClassification: "policy_state_change" }),
        candidate(C, { workflowClassification: "policy_reactivation" }),
      ],
      [verdict(A, B, "same_underlying_workflow"), verdict(B, C, "same_underlying_workflow")],
    );
    expect(clusters[0]?.dominantWorkflowClassification).toBe("policy_state_change");
    expect(clusters[0]?.workflowClassifications).toEqual(["policy_reactivation", "policy_state_change"]);
  });

  it("breaks a dominance tie alphabetically for stability", () => {
    const { clusters } = buildWorkflowClusters(
      [
        candidate(A, { workflowClassification: "policy_state_change" }),
        candidate(B, { workflowClassification: "account_data_update" }),
      ],
      [verdict(A, B, "same_underlying_workflow")],
    );
    expect(clusters[0]?.dominantWorkflowClassification).toBe("account_data_update");
  });

  it("derives firstSeen and lastSeen from member timestamps", () => {
    const { clusters } = buildWorkflowClusters(
      [candidate(A), candidate(C)],
      [verdict(A, C, "same_underlying_workflow")],
    );
    expect(clusters[0]?.firstSeen).toBe(new Date(Number.parseFloat(A) * 1000).toISOString());
    expect(clusters[0]?.lastSeen).toBe(new Date(Number.parseFloat(C) * 1000).toISOString());
  });

  it("carries sample permalinks as local evidence", () => {
    const { clusters } = buildWorkflowClusters(
      [candidate(A), candidate(B)],
      [verdict(A, B, "same_underlying_workflow")],
    );
    expect(clusters[0]?.samplePermalinks).toEqual([`https://slack.example/p${A}`, `https://slack.example/p${B}`]);
  });

  it("handles members with a null classification without inventing one", () => {
    const { clusters } = buildWorkflowClusters([candidate(A, { workflowClassification: null })], []);
    expect(clusters[0]?.dominantWorkflowClassification).toBeNull();
    expect(clusters[0]?.workflowClassifications).toEqual([]);
  });
});

describe("RELATED edges become cross-cluster links", () => {
  it("records the relationship on both clusters without merging them", () => {
    const { clusters } = buildWorkflowClusters(
      [candidate(A), candidate(B), candidate(C), candidate(D)],
      [
        verdict(A, B, "same_underlying_workflow"),
        verdict(C, D, "same_underlying_workflow"),
        verdict(B, C, "related_workflow_family"),
      ],
    );

    expect(clusters).toHaveLength(2);
    const left = clusterFor(clusters, A);
    const right = clusterFor(clusters, C);
    expect(left.relatedClusterIds).toEqual([right.clusterId]);
    expect(right.relatedClusterIds).toEqual([left.clusterId]);
  });

  it("does not record a self-link when both sides are already one cluster", () => {
    const { clusters } = buildWorkflowClusters(
      [candidate(A), candidate(B)],
      [verdict(A, B, "same_underlying_workflow"), verdict(A, B, "related_workflow_family")],
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.relatedClusterIds).toEqual([]);
  });

  it("leaves relatedClusterIds empty when there are no RELATED edges", () => {
    const { clusters } = buildWorkflowClusters(
      [candidate(A), candidate(B)],
      [verdict(A, B, "same_underlying_workflow")],
    );
    expect(clusters[0]?.relatedClusterIds).toEqual([]);
  });
});

describe("CLI args and output path", () => {
  it("defaults both inputs to auto-resolution and top to 10", () => {
    expect(parseWorkflowClustersArgs([])).toEqual({
      extractions: undefined, adjudications: undefined, dryRun: false, top: 10,
    });
  });

  it("parses explicit inputs", () => {
    const args = parseWorkflowClustersArgs([
      "--extractions=e.json",
      "--adjudications=a.json",
      "--dry-run",
      "--top=3",
    ]);
    expect(args).toEqual({ extractions: "e.json", adjudications: "a.json", dryRun: true, top: 3 });
  });

  it("rejects an invalid --top", () => {
    expect(() => parseWorkflowClustersArgs(["--top=0"])).toThrow(/Invalid --top/);
  });

  it("writes to a workflow-specific filename", () => {
    const filePath = workflowClusterOutputFilePath("/d", new Date("2026-08-13T00:00:00.000Z"), "180d");
    expect(filePath).toContain("workflow-clusters-180d-2026-08-13.json");
  });
});
