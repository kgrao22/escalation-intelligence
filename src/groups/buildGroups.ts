import { createHash } from "node:crypto";
import { isRelatedRelationship } from "../llm/schemas/workflowAdjudication.js";
import type { EscalationAnalysis } from "../llm/schemas/escalationAnalysis.js";
import type { AdjudicationResultItem } from "../persistence/adjudicationOutput.js";
import { tsToIso } from "../slack/escalationThreads.js";
import { buildAdjacency, connectedComponents, findOverlappingMembers, maximalCliques } from "./graph.js";
import {
  assessGroupConsistency,
  buildRelationshipMatrix,
  type RelationshipMatrix,
} from "./relationshipMatrix.js";

export interface RecurringIssueMember {
  rootTs: string;
  normalizedProblemStatement: string;
  permalink: string | null;
  postedAt: string | null;
  classification?: string | null;
  affectedSystem?: string | null;
  severity?: string | null;
  customerImpact?: string | null;
  suspectedRootCause?: string | null;
  resolutionStatus?: string | null;
  resolutionSummary?: string | null;
  /**
   * Manual-workflow fields. Present on every member so a workflow group can be
   * reported without re-reading extractions; null on purely technical threads.
   */
  normalizedWorkflowStatement?: string | null;
  workflowClassification?: string | null;
  automationStatus?: string | null;
}

export interface RecurringIssueGroup {
  groupId: string;
  name: string | null;
  alternateNames: string[];
  members: RecurringIssueMember[];
  occurrenceCount: number;
  firstSeen: string | null;
  lastSeen: string | null;
  averageSameEdgeConfidence: number;
  minimumSameEdgeConfidence: number;
  averageSameEdgeSimilarity: number;
  minimumSameEdgeSimilarity: number;
  consistency: "fully_confirmed" | "incomplete_pair_evidence" | "conflicted";
  /** True when this group was carved out of a component that contradicted itself. */
  splitFromConflictedComponent: boolean;
  sameEdges: string[];
  relatedEdgesInsideGroup: string[];
  differentEdgesInsideGroup: string[];
  unadjudicatedPairsInsideGroup: string[];
}

export interface GroupBuildStats {
  sameEdges: number;
  relatedEdges: number;
  differentEdges: number;
  candidateComponents: number;
  conflictedComponents: number;
  recurringGroups: number;
  overlappingGroups: number;
  overlappingMembers: Array<{ member: string; groupIds: string[] }>;
}

export interface BuildGroupsResult {
  groups: RecurringIssueGroup[];
  stats: GroupBuildStats;
}

/** Stable, content-derived id so the same membership always yields the same id. */
export function groupIdFor(members: string[]): string {
  const digest = createHash("sha256").update([...members].sort().join("::")).digest("hex");
  return `grp_${digest.slice(0, 12)}`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Deterministic name selection: the proposed name attached to the
 * highest-confidence SAME edge inside the group, breaking ties by similarity
 * then pairId. No name is invented locally — every candidate comes from an
 * adjudication that actually judged two of these members the same.
 */
export function selectGroupName(sameEdges: AdjudicationResultItem[]): {
  name: string | null;
  alternateNames: string[];
} {
  const named = sameEdges
    .filter((edge) => typeof edge.proposedRecurringIssueName === "string" && edge.proposedRecurringIssueName.trim() !== "")
    .sort((left, right) => {
      const confidence = (right.confidence ?? 0) - (left.confidence ?? 0);
      if (confidence !== 0) {
        return confidence;
      }
      const similarity = right.similarity - left.similarity;
      if (similarity !== 0) {
        return similarity;
      }
      return left.pairId.localeCompare(right.pairId);
    });

  if (named.length === 0) {
    return { name: null, alternateNames: [] };
  }

  const name = named[0]?.proposedRecurringIssueName as string;
  const alternateNames = [
    ...new Set(named.slice(1).map((edge) => edge.proposedRecurringIssueName as string)),
  ].filter((candidate) => candidate !== name);

  return { name, alternateNames };
}

function buildMember(
  rootTs: string,
  matrixEdges: AdjudicationResultItem[],
  analysis: EscalationAnalysis | undefined,
): RecurringIssueMember {
  const side = matrixEdges
    .flatMap((edge) => [edge.a, edge.b])
    .find((candidate) => candidate.rootTs === rootTs);

  const postedAt = (() => {
    const iso = tsToIso(rootTs);
    return iso === rootTs ? null : iso;
  })();

  return {
    rootTs,
    normalizedProblemStatement:
      analysis?.normalizedProblemStatement ?? side?.normalizedProblemStatement ?? "",
    permalink: analysis?.permalink ?? side?.permalink ?? null,
    postedAt,
    classification: analysis?.classification ?? null,
    affectedSystem: analysis?.affectedSystem ?? null,
    severity: analysis?.severity ?? null,
    customerImpact: analysis?.customerImpact ?? null,
    suspectedRootCause: analysis?.suspectedRootCause ?? null,
    resolutionStatus: analysis?.resolutionStatus ?? null,
    resolutionSummary: analysis?.resolutionSummary ?? null,
    normalizedWorkflowStatement: analysis?.normalizedWorkflowStatement ?? null,
    workflowClassification: analysis?.workflowClassification ?? null,
    automationStatus: analysis?.automationStatus ?? null,
  };
}

function buildGroup(
  members: string[],
  matrix: RelationshipMatrix,
  extractionIndex: Map<string, EscalationAnalysis>,
  splitFromConflictedComponent: boolean,
): RecurringIssueGroup {
  const memberSet = new Set(members);
  const internalSameEdges = matrix.sameEdges.filter(
    (edge) => memberSet.has(edge.a.rootTs) && memberSet.has(edge.b.rootTs),
  );

  const report = assessGroupConsistency(members, matrix);
  const { name, alternateNames } = selectGroupName(internalSameEdges);

  const confidences = internalSameEdges.map((edge) => edge.confidence).filter(isFiniteNumber);
  const similarities = internalSameEdges.map((edge) => edge.similarity).filter(isFiniteNumber);

  const built = [...members]
    .sort()
    .map((rootTs) => buildMember(rootTs, internalSameEdges, extractionIndex.get(rootTs)));

  const timestamps = built
    .map((member) => member.postedAt)
    .filter((value): value is string => value !== null)
    .sort();

  return {
    groupId: groupIdFor(members),
    name,
    alternateNames,
    members: built,
    // Unique escalation threads, never the number of pairwise edges.
    occurrenceCount: memberSet.size,
    firstSeen: timestamps[0] ?? null,
    lastSeen: timestamps.at(-1) ?? null,
    averageSameEdgeConfidence: average(confidences),
    minimumSameEdgeConfidence: confidences.length === 0 ? 0 : Math.min(...confidences),
    averageSameEdgeSimilarity: average(similarities),
    minimumSameEdgeSimilarity: similarities.length === 0 ? 0 : Math.min(...similarities),
    consistency: report.consistency,
    splitFromConflictedComponent,
    sameEdges: report.sameEdges,
    relatedEdgesInsideGroup: report.relatedEdgesInsideGroup,
    differentEdgesInsideGroup: report.differentEdgesInsideGroup,
    unadjudicatedPairsInsideGroup: report.unadjudicatedPairs,
  };
}

/**
 * Components first, cliques only on conflict.
 *
 * A connected component of SAME edges is emitted whole unless its own
 * evidence contradicts it. That distinction matters: a pair that was never
 * adjudicated (because it fell below the candidate similarity floor) is
 * missing evidence, not contrary evidence, so the group is flagged
 * `incomplete_pair_evidence` for review rather than silently split apart.
 * Only an explicit RELATED or DIFFERENT verdict inside a component triggers
 * splitting into maximal SAME-cliques, each of which is fully confirmed by
 * construction.
 */
export function buildRecurringIssueGroups(
  results: AdjudicationResultItem[],
  extractionIndex: Map<string, EscalationAnalysis>,
): BuildGroupsResult {
  const successful = results.filter((result) => result.status === "success" && result.relationship);
  const matrix = buildRelationshipMatrix(successful);

  const relatedEdges = successful.filter((r) => isRelatedRelationship(r.relationship)).length;
  const differentEdges = successful.filter((r) => r.relationship === "different").length;

  const adjacency = buildAdjacency(matrix.sameEdges.map((edge) => [edge.a.rootTs, edge.b.rootTs]));
  const components = connectedComponents(adjacency);

  const groups: RecurringIssueGroup[] = [];
  let conflictedComponents = 0;

  for (const component of components) {
    const report = assessGroupConsistency(component, matrix);

    if (report.consistency !== "conflicted") {
      groups.push(buildGroup(component, matrix, extractionIndex, false));
      continue;
    }

    conflictedComponents += 1;
    for (const clique of maximalCliques(adjacency, component)) {
      if (clique.length < 2) {
        continue;
      }
      groups.push(buildGroup(clique, matrix, extractionIndex, true));
    }
  }

  // Largest and most-recurrent issues first; stable tie-break on id.
  groups.sort((left, right) =>
    left.occurrenceCount === right.occurrenceCount
      ? left.groupId.localeCompare(right.groupId)
      : right.occurrenceCount - left.occurrenceCount,
  );

  const overlaps = findOverlappingMembers(groups.map((group) => group.members.map((m) => m.rootTs)));
  const overlappingMembers = overlaps.map((overlap) => ({
    member: overlap.member,
    groupIds: overlap.groupIndexes.map((index) => groups[index]?.groupId ?? "").filter(Boolean),
  }));

  return {
    groups,
    stats: {
      sameEdges: matrix.sameEdges.length,
      relatedEdges,
      differentEdges,
      candidateComponents: components.length,
      conflictedComponents,
      recurringGroups: groups.length,
      overlappingGroups: new Set(overlappingMembers.flatMap((o) => o.groupIds)).size,
      overlappingMembers,
    },
  };
}
