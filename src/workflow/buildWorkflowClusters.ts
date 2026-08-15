import { tsToIso } from "../slack/escalationThreads.js";
import type { WorkflowAdjudicationResultItem } from "../persistence/workflowAdjudicationOutput.js";
import type { WorkflowEmbeddingCandidate } from "./workflowEmbeddingCandidates.js";

export class WorkflowClusterIntegrityError extends Error {
  constructor(message: string) {
    super(`Workflow cluster integrity violated: ${message}`);
    this.name = "WorkflowClusterIntegrityError";
  }
}

export interface WorkflowCluster {
  clusterId: string;
  occurrenceCount: number;
  memberRootTs: string[];
  workflowClassifications: string[];
  dominantWorkflowClassification: string | null;
  automationStatusBreakdown: Record<string, number>;
  technicalWorkflowCount: number;
  workflowOnlyCount: number;
  firstSeen: string | null;
  lastSeen: string | null;
  representativeWorkflowStatement: string;
  /** rootTs of the member the representative statement came from. */
  representativeRootTs: string;
  samplePermalinks: string[];
  relatedClusterIds: string[];
  /** SAME edges wholly inside this cluster. A singleton has none. */
  internalSameEdgeCount: number;
}

export interface WorkflowClusterStats {
  totalWorkflowCandidates: number;
  adjudicatedPairs: number;
  sameEdges: number;
  relatedEdges: number;
  differentEdges: number;
  /** SAME edges naming a rootTs absent from the candidate set; never silently ignored. */
  danglingSameEdges: number;
  totalClusters: number;
  recurringClusters: number;
  singletonClusters: number;
  largestClusterSize: number;
}

export interface WorkflowClusterResult {
  clusters: WorkflowCluster[];
  stats: WorkflowClusterStats;
}

/** Maximum permalinks carried per cluster — enough to spot-check, not a dump. */
const MAX_SAMPLE_PERMALINKS = 5;

class DisjointSet {
  private readonly parent = new Map<string, string>();

  add(node: string): void {
    if (!this.parent.has(node)) {
      this.parent.set(node, node);
    }
  }

  find(node: string): string {
    let current = node;
    while (this.parent.get(current) !== current) {
      const next = this.parent.get(current) as string;
      this.parent.set(current, this.parent.get(next) as string);
      current = this.parent.get(current) as string;
    }
    return current;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) {
      // Deterministic: the lexicographically smaller root always wins, so the
      // component's representative never depends on edge iteration order.
      const [keep, merge] = rootA < rootB ? [rootA, rootB] : [rootB, rootA];
      this.parent.set(merge, keep);
    }
  }
}

function isSame(result: WorkflowAdjudicationResultItem): boolean {
  return result.status === "success" && result.relationship === "same_underlying_workflow";
}

function isRelated(result: WorkflowAdjudicationResultItem): boolean {
  return result.status === "success" && result.relationship === "related_workflow_family";
}

function iso(rootTs: string): string | null {
  const value = tsToIso(rootTs);
  return value === rootTs ? null : value;
}

/**
 * Builds recurring workflow clusters from pairwise verdicts.
 *
 * Connected components over SAME_UNDERLYING_WORKFLOW edges ONLY. Deliberately
 * NOT merged by:
 *   - related_workflow_family — kept as a cross-cluster pointer instead, because
 *     "same operational area" is explicitly not "same task";
 *   - embedding similarity — the floor is candidate generation, not a verdict;
 *   - workflowClassification — calibration showed identical tasks carrying
 *     different labels, so the label is evidence about naming, not identity.
 * A `different` verdict never contributes an edge under any circumstances.
 *
 * Every candidate lands in exactly one cluster; one with no SAME edge becomes a
 * singleton. The invariants are checked, not assumed.
 */
export function buildWorkflowClusters(
  candidates: WorkflowEmbeddingCandidate[],
  adjudications: WorkflowAdjudicationResultItem[],
): WorkflowClusterResult {
  const byRootTs = new Map(candidates.map((candidate) => [candidate.rootTs, candidate]));
  if (byRootTs.size !== candidates.length) {
    throw new WorkflowClusterIntegrityError(
      `the candidate set contains duplicate rootTs values (${candidates.length} candidates, ${byRootTs.size} unique).`,
    );
  }

  const dsu = new DisjointSet();
  for (const candidate of candidates) {
    dsu.add(candidate.rootTs);
  }

  const sameResults = adjudications.filter(isSame);
  let danglingSameEdges = 0;
  for (const result of sameResults) {
    const { rootTs: left } = result.a;
    const { rootTs: right } = result.b;
    if (!byRootTs.has(left) || !byRootTs.has(right)) {
      // An edge to a thread that is not a current candidate cannot be merged
      // into anything; count it so the discrepancy is visible, never silent.
      danglingSameEdges += 1;
      continue;
    }
    dsu.union(left, right);
  }

  // --- Group members by component root -------------------------------------
  const membersByRoot = new Map<string, string[]>();
  for (const candidate of candidates) {
    const root = dsu.find(candidate.rootTs);
    const bucket = membersByRoot.get(root);
    if (bucket) {
      bucket.push(candidate.rootTs);
    } else {
      membersByRoot.set(root, [candidate.rootTs]);
    }
  }

  // Cluster id = smallest member rootTs. Deterministic, stable, and traceable
  // back to a real thread — no random UUIDs.
  const clusterIdFor = (members: string[]): string => `wf-${[...members].sort()[0] as string}`;

  // --- Per-component SAME edge degree, for representative selection ---------
  const degreeWithinComponent = new Map<string, number>();
  const internalEdgesByRoot = new Map<string, number>();
  for (const result of sameResults) {
    const left = result.a.rootTs;
    const right = result.b.rootTs;
    if (!byRootTs.has(left) || !byRootTs.has(right)) {
      continue;
    }
    degreeWithinComponent.set(left, (degreeWithinComponent.get(left) ?? 0) + 1);
    degreeWithinComponent.set(right, (degreeWithinComponent.get(right) ?? 0) + 1);
    const root = dsu.find(left);
    internalEdgesByRoot.set(root, (internalEdgesByRoot.get(root) ?? 0) + 1);
  }

  const clusterIdByRootTs = new Map<string, string>();
  for (const members of membersByRoot.values()) {
    const clusterId = clusterIdFor(members);
    for (const member of members) {
      clusterIdByRootTs.set(member, clusterId);
    }
  }

  // --- RELATED edges become cross-cluster pointers, never merges ------------
  const relatedByCluster = new Map<string, Set<string>>();
  for (const result of adjudications.filter(isRelated)) {
    const left = clusterIdByRootTs.get(result.a.rootTs);
    const right = clusterIdByRootTs.get(result.b.rootTs);
    if (!left || !right || left === right) {
      continue;
    }
    for (const [from, to] of [
      [left, right],
      [right, left],
    ] as const) {
      const existing = relatedByCluster.get(from);
      if (existing) {
        existing.add(to);
      } else {
        relatedByCluster.set(from, new Set([to]));
      }
    }
  }

  // --- Build clusters -------------------------------------------------------
  const clusters: WorkflowCluster[] = [];
  for (const [root, unsortedMembers] of membersByRoot) {
    const memberRootTs = [...unsortedMembers].sort();
    const clusterId = clusterIdFor(memberRootTs);
    const members = memberRootTs.map((rootTs) => byRootTs.get(rootTs) as WorkflowEmbeddingCandidate);

    const classificationCounts = new Map<string, number>();
    for (const member of members) {
      if (member.workflowClassification !== null) {
        classificationCounts.set(
          member.workflowClassification,
          (classificationCounts.get(member.workflowClassification) ?? 0) + 1,
        );
      }
    }
    // Most frequent wins; ties break alphabetically so the result is stable.
    const dominantWorkflowClassification =
      [...classificationCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

    const automationStatusBreakdown: Record<string, number> = {};
    for (const member of members) {
      automationStatusBreakdown[member.automationStatus] =
        (automationStatusBreakdown[member.automationStatus] ?? 0) + 1;
    }

    // Representative: the member with the most SAME edges — the one the model
    // agreed with most often — then lowest rootTs to break ties deterministically.
    const representative = [...members].sort((a, b) => {
      const degreeDelta = (degreeWithinComponent.get(b.rootTs) ?? 0) - (degreeWithinComponent.get(a.rootTs) ?? 0);
      return degreeDelta !== 0 ? degreeDelta : a.rootTs.localeCompare(b.rootTs);
    })[0] as WorkflowEmbeddingCandidate;

    const timestamps = memberRootTs.map((rootTs) => iso(rootTs)).filter((v): v is string => v !== null).sort();

    clusters.push({
      clusterId,
      occurrenceCount: members.length,
      memberRootTs,
      workflowClassifications: [...classificationCounts.keys()].sort(),
      dominantWorkflowClassification,
      automationStatusBreakdown: Object.fromEntries(
        Object.entries(automationStatusBreakdown).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      ),
      technicalWorkflowCount: members.filter((m) => m.nature === "technical+workflow").length,
      workflowOnlyCount: members.filter((m) => m.nature === "workflow-only").length,
      firstSeen: timestamps[0] ?? null,
      lastSeen: timestamps.at(-1) ?? null,
      representativeWorkflowStatement: representative.statement,
      representativeRootTs: representative.rootTs,
      samplePermalinks: members
        .map((member) => member.permalink)
        .filter((link): link is string => link !== null)
        .slice(0, MAX_SAMPLE_PERMALINKS),
      relatedClusterIds: [...(relatedByCluster.get(clusterId) ?? [])].sort(),
      internalSameEdgeCount: internalEdgesByRoot.get(root) ?? 0,
    });
  }

  // Deterministic ordering: biggest first, then by id.
  clusters.sort((a, b) => b.occurrenceCount - a.occurrenceCount || a.clusterId.localeCompare(b.clusterId));

  assertClusterIntegrity(clusters, candidates);

  const singletonClusters = clusters.filter((cluster) => cluster.occurrenceCount === 1).length;
  return {
    clusters,
    stats: {
      totalWorkflowCandidates: candidates.length,
      adjudicatedPairs: adjudications.filter((result) => result.status === "success").length,
      sameEdges: sameResults.length,
      relatedEdges: adjudications.filter(isRelated).length,
      differentEdges: adjudications.filter(
        (result) => result.status === "success" && result.relationship === "different",
      ).length,
      danglingSameEdges,
      totalClusters: clusters.length,
      recurringClusters: clusters.length - singletonClusters,
      singletonClusters,
      largestClusterSize: clusters[0]?.occurrenceCount ?? 0,
    },
  };
}

/**
 * Fails loudly rather than emitting a partially-correct artifact. A member
 * silently lost or double-counted here would misstate automation frequency
 * everywhere downstream, and would be very hard to trace back.
 */
export function assertClusterIntegrity(
  clusters: WorkflowCluster[],
  candidates: WorkflowEmbeddingCandidate[],
): void {
  const seen = new Map<string, string[]>();
  for (const cluster of clusters) {
    for (const rootTs of cluster.memberRootTs) {
      const owners = seen.get(rootTs);
      if (owners) {
        owners.push(cluster.clusterId);
      } else {
        seen.set(rootTs, [cluster.clusterId]);
      }
    }
  }

  const duplicated = [...seen.entries()].filter(([, owners]) => owners.length > 1);
  if (duplicated.length > 0) {
    const detail = duplicated
      .slice(0, 5)
      .map(([rootTs, owners]) => `${rootTs} in ${owners.join(", ")}`)
      .join("; ");
    throw new WorkflowClusterIntegrityError(`${duplicated.length} rootTs appear in more than one cluster: ${detail}`);
  }

  const expected = new Set(candidates.map((candidate) => candidate.rootTs));
  const missing = [...expected].filter((rootTs) => !seen.has(rootTs));
  if (missing.length > 0) {
    throw new WorkflowClusterIntegrityError(
      `${missing.length} workflow candidates are in no cluster: ${missing.slice(0, 5).join(", ")}`,
    );
  }

  const unexpected = [...seen.keys()].filter((rootTs) => !expected.has(rootTs));
  if (unexpected.length > 0) {
    throw new WorkflowClusterIntegrityError(
      `${unexpected.length} clustered rootTs are not workflow candidates: ${unexpected.slice(0, 5).join(", ")}`,
    );
  }

  const totalMembers = clusters.reduce((sum, cluster) => sum + cluster.memberRootTs.length, 0);
  if (totalMembers !== candidates.length) {
    throw new WorkflowClusterIntegrityError(
      `total cluster members (${totalMembers}) does not equal workflow candidates (${candidates.length}).`,
    );
  }

  for (const cluster of clusters) {
    if (cluster.occurrenceCount !== cluster.memberRootTs.length) {
      throw new WorkflowClusterIntegrityError(
        `${cluster.clusterId} reports ${cluster.occurrenceCount} occurrences but holds ${cluster.memberRootTs.length} members.`,
      );
    }
  }
}
