import type { RankedGroup } from "../report/rankGroups.js";
import { scrubIdentifiers, scrubOptional } from "./scrubIdentifiers.js";

export interface RecommendationOccurrence {
  normalizedProblemStatement: string;
  severity: string;
  customerImpact: string;
  resolutionStatus: string;
  suspectedRootCause: string | null;
  resolutionSummary: string | null;
}

/**
 * Exactly what is sent to Claude for one recurring issue.
 *
 * Note what is absent by construction: Slack permalinks, rootTs values, raw
 * thread text, author ids, channel ids. Those stay local — they are needed to
 * render the eventual report, not to decide what engineering should do.
 */
export interface RecommendationPayload {
  name: string;
  occurrenceCount: number;
  firstSeen: string | null;
  lastSeen: string | null;
  spanDays: number | null;
  daysSinceLastOccurrence: number | null;
  severityDistribution: Array<{ value: string; count: number }>;
  customerImpactDistribution: Array<{ value: string; count: number }>;
  resolutionStatusDistribution: Array<{ value: string; count: number }>;
  affectedSystems: string[];
  occurrences: RecommendationOccurrence[];
  /** How many identifier-shaped tokens were redacted while building this payload. */
  redactionCount: number;
}

const nonZero = (entries: Array<{ value: string; count: number }>) => entries.filter((entry) => entry.count > 0);

export function buildRecommendationPayload(issue: RankedGroup): RecommendationPayload {
  let redactionCount = 0;

  const scrub = (value: string | null | undefined): string | null => {
    const result = scrubOptional(value);
    redactionCount += result.redactionCount;
    return result.text === "" ? null : result.text;
  };

  const name = (() => {
    if (!issue.name) {
      return "(no proposed name)";
    }
    const result = scrubIdentifiers(issue.name);
    redactionCount += result.redactionCount;
    return result.text;
  })();

  const affectedSystems = issue.affectedSystems
    .map((system) => scrub(system))
    .filter((system): system is string => system !== null);

  const occurrences: RecommendationOccurrence[] = issue.occurrences.map((occurrence) => ({
    normalizedProblemStatement: scrub(occurrence.normalizedProblemStatement) ?? "",
    severity: occurrence.severity,
    customerImpact: occurrence.customerImpact,
    resolutionStatus: occurrence.resolutionStatus,
    suspectedRootCause: scrub(occurrence.suspectedRootCause),
    resolutionSummary: scrub(occurrence.resolutionSummary),
  }));

  return {
    name,
    occurrenceCount: issue.occurrenceCount,
    firstSeen: issue.window.firstSeen,
    lastSeen: issue.window.lastSeen,
    spanDays: issue.window.spanDays,
    daysSinceLastOccurrence: issue.window.daysSinceLastOccurrence,
    severityDistribution: nonZero(issue.severityDistribution),
    customerImpactDistribution: nonZero(issue.customerImpactDistribution),
    resolutionStatusDistribution: nonZero(issue.resolutionStatusDistribution),
    affectedSystems,
    occurrences,
    redactionCount,
  };
}
