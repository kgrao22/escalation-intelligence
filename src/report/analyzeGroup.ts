import type { RecurringIssueGroup } from "../groups/buildGroups.js";
import {
  CUSTOMER_IMPACT_ORDER,
  CUSTOMER_IMPACT_RANK,
  distribute,
  RESOLUTION_STATUS_ORDER,
  SEVERITY_ORDER,
  SEVERITY_RANK,
  toCustomerImpactBucket,
  toResolutionStatusBucket,
  toSeverityBucket,
  type CustomerImpactBucket,
  type DistributionEntry,
  type ResolutionStatusBucket,
  type SeverityBucket,
} from "./distributions.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface RecurrenceWindow {
  firstSeen: string | null;
  lastSeen: string | null;
  /** Whole days between the first and last occurrence; null when dates are unavailable. */
  spanDays: number | null;
  /**
   * spanDays / (occurrences - 1) — the mean gap between consecutive
   * occurrences. Null for a single-occurrence group or when dates are
   * unavailable. Reported to one decimal place by renderers, not rounded here.
   */
  averageDaysBetweenOccurrences: number | null;
  /** Days since the most recent occurrence, relative to the report's asOf. */
  daysSinceLastOccurrence: number | null;
}

export interface ResolutionPosture {
  unresolvedCount: number;
  workaroundCount: number;
  resolvedCount: number;
  /** Occurrences still needing engineering work: unresolved + workaround. */
  openCount: number;
  hasUnresolvedOccurrences: boolean;
  hasWorkaroundOccurrences: boolean;
  /** True when at least one occurrence is unresolved or resting on a workaround. */
  hasOpenOccurrences: boolean;
  /** True when every occurrence was resolved outright. */
  fullyResolved: boolean;
}

export interface AnalyzedGroup {
  groupId: string;
  name: string | null;
  alternateNames: string[];
  occurrenceCount: number;
  consistency: RecurringIssueGroup["consistency"];
  needsReview: boolean;
  window: RecurrenceWindow;
  severityDistribution: Array<DistributionEntry<SeverityBucket>>;
  customerImpactDistribution: Array<DistributionEntry<CustomerImpactBucket>>;
  resolutionStatusDistribution: Array<DistributionEntry<ResolutionStatusBucket>>;
  peakSeverity: SeverityBucket;
  peakCustomerImpact: CustomerImpactBucket;
  affectedSystems: string[];
  resolution: ResolutionPosture;
  averageSameEdgeConfidence: number;
  minimumSameEdgeConfidence: number;
  averageSameEdgeSimilarity: number;
  occurrences: Array<{
    rootTs: string;
    postedAt: string | null;
    permalink: string | null;
    normalizedProblemStatement: string;
    severity: SeverityBucket;
    customerImpact: CustomerImpactBucket;
    resolutionStatus: ResolutionStatusBucket;
    affectedSystem: string | null;
    /** Carried through so the report is a self-sufficient input for recommendations. */
    suspectedRootCause: string | null;
    resolutionSummary: string | null;
  }>;
}

function diffInDays(from: string, to: string): number | null {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return null;
  }
  return Math.round((end - start) / MS_PER_DAY);
}

export function analyzeGroup(group: RecurringIssueGroup, asOf: Date): AnalyzedGroup {
  const severities = group.members.map((member) => toSeverityBucket(member.severity));
  const impacts = group.members.map((member) => toCustomerImpactBucket(member.customerImpact));
  const statuses = group.members.map((member) => toResolutionStatusBucket(member.resolutionStatus));

  const spanDays =
    group.firstSeen && group.lastSeen ? diffInDays(group.firstSeen, group.lastSeen) : null;
  const averageDaysBetweenOccurrences =
    spanDays !== null && group.occurrenceCount > 1 ? spanDays / (group.occurrenceCount - 1) : null;
  const daysSinceLastOccurrence = group.lastSeen ? diffInDays(group.lastSeen, asOf.toISOString()) : null;

  const unresolvedCount = statuses.filter((status) => status === "unresolved").length;
  const workaroundCount = statuses.filter((status) => status === "workaround").length;
  const resolvedCount = statuses.filter((status) => status === "resolved").length;
  const openCount = unresolvedCount + workaroundCount;

  const peakSeverity = [...severities].sort((a, b) => SEVERITY_RANK[b] - SEVERITY_RANK[a])[0] ?? "unspecified";
  const peakCustomerImpact =
    [...impacts].sort((a, b) => CUSTOMER_IMPACT_RANK[b] - CUSTOMER_IMPACT_RANK[a])[0] ?? "unspecified";

  const affectedSystems = [
    ...new Set(
      group.members
        .map((member) => member.affectedSystem)
        .filter((system): system is string => typeof system === "string" && system.trim() !== ""),
    ),
  ].sort();

  return {
    groupId: group.groupId,
    name: group.name,
    alternateNames: group.alternateNames,
    occurrenceCount: group.occurrenceCount,
    consistency: group.consistency,
    needsReview: group.consistency !== "fully_confirmed",
    window: {
      firstSeen: group.firstSeen,
      lastSeen: group.lastSeen,
      spanDays,
      averageDaysBetweenOccurrences,
      daysSinceLastOccurrence,
    },
    severityDistribution: distribute(severities, SEVERITY_ORDER),
    customerImpactDistribution: distribute(impacts, CUSTOMER_IMPACT_ORDER),
    resolutionStatusDistribution: distribute(statuses, RESOLUTION_STATUS_ORDER),
    peakSeverity,
    peakCustomerImpact,
    affectedSystems,
    resolution: {
      unresolvedCount,
      workaroundCount,
      resolvedCount,
      openCount,
      hasUnresolvedOccurrences: unresolvedCount > 0,
      hasWorkaroundOccurrences: workaroundCount > 0,
      hasOpenOccurrences: openCount > 0,
      fullyResolved: resolvedCount === group.members.length && group.members.length > 0,
    },
    averageSameEdgeConfidence: group.averageSameEdgeConfidence,
    minimumSameEdgeConfidence: group.minimumSameEdgeConfidence,
    averageSameEdgeSimilarity: group.averageSameEdgeSimilarity,
    occurrences: group.members.map((member, index) => ({
      rootTs: member.rootTs,
      postedAt: member.postedAt,
      permalink: member.permalink,
      normalizedProblemStatement: member.normalizedProblemStatement,
      severity: severities[index] as SeverityBucket,
      customerImpact: impacts[index] as CustomerImpactBucket,
      resolutionStatus: statuses[index] as ResolutionStatusBucket,
      affectedSystem: member.affectedSystem ?? null,
      suspectedRootCause: member.suspectedRootCause ?? null,
      resolutionSummary: member.resolutionSummary ?? null,
    })),
  };
}
