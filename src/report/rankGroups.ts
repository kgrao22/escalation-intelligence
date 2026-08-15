import type { AnalyzedGroup } from "./analyzeGroup.js";
import { CUSTOMER_IMPACT_RANK, SEVERITY_RANK } from "./distributions.js";

export interface RankingSignals {
  occurrenceCount: number;
  openCount: number;
  peakSeverityRank: number;
  peakCustomerImpactRank: number;
  /** Epoch millis of the last occurrence; 0 when no date is available. */
  lastSeenAt: number;
}

export interface RankedGroup extends AnalyzedGroup {
  rank: number;
  rankingSignals: RankingSignals;
}

/**
 * The ordering criteria, most significant first. Exported so a renderer (or a
 * reader of the JSON) can state exactly why one issue outranks another.
 */
export const RANKING_CRITERIA: readonly string[] = [
  "occurrenceCount desc — how often the issue actually recurred",
  "openCount desc — occurrences still unresolved or resting on a workaround",
  "peakSeverityRank desc — worst severity seen across occurrences",
  "peakCustomerImpactRank desc — broadest customer impact seen",
  "lastSeenAt desc — most recently active first",
  "groupId asc — stable tie-break so output is deterministic",
];

export function rankingSignalsFor(group: AnalyzedGroup): RankingSignals {
  const lastSeenAt = group.window.lastSeen ? Date.parse(group.window.lastSeen) : Number.NaN;
  return {
    occurrenceCount: group.occurrenceCount,
    openCount: group.resolution.openCount,
    peakSeverityRank: SEVERITY_RANK[group.peakSeverity],
    peakCustomerImpactRank: CUSTOMER_IMPACT_RANK[group.peakCustomerImpact],
    lastSeenAt: Number.isNaN(lastSeenAt) ? 0 : lastSeenAt,
  };
}

/**
 * Deliberately a tiered lexicographic ordering, not a weighted composite
 * score.
 *
 * A weighted score would require inventing weights, and this project has
 * consistently chosen to calibrate such numbers against real labelled data
 * rather than guess them. Automation-opportunity scoring is its own milestone;
 * this layer only decides *presentation order*, and every signal it uses is
 * emitted alongside the result so the order can be audited or re-derived
 * differently later.
 *
 * Frequency leads because the product question is "which issues recur", and
 * an unresolved backlog breaks ties before severity does — a frequently
 * recurring issue that is still open is the one engineering most needs to see.
 */
export function compareForRanking(left: AnalyzedGroup, right: AnalyzedGroup): number {
  const a = rankingSignalsFor(left);
  const b = rankingSignalsFor(right);

  return (
    b.occurrenceCount - a.occurrenceCount ||
    b.openCount - a.openCount ||
    b.peakSeverityRank - a.peakSeverityRank ||
    b.peakCustomerImpactRank - a.peakCustomerImpactRank ||
    b.lastSeenAt - a.lastSeenAt ||
    left.groupId.localeCompare(right.groupId)
  );
}

export function rankGroups(groups: AnalyzedGroup[]): RankedGroup[] {
  return [...groups]
    .sort(compareForRanking)
    .map((group, index) => ({ ...group, rank: index + 1, rankingSignals: rankingSignalsFor(group) }));
}
