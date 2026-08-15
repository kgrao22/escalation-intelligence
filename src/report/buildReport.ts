import type { GroupOutput } from "../persistence/groupOutput.js";
import { analyzeGroup } from "./analyzeGroup.js";
import {
  CUSTOMER_IMPACT_ORDER,
  distribute,
  RESOLUTION_STATUS_ORDER,
  SEVERITY_ORDER,
  type CustomerImpactBucket,
  type DistributionEntry,
  type ResolutionStatusBucket,
  type SeverityBucket,
} from "./distributions.js";
import { rankGroups, RANKING_CRITERIA, type RankedGroup } from "./rankGroups.js";

export interface ReportSummary {
  recurringIssueCount: number;
  /** Unique escalation threads across all recurring issues. */
  totalOccurrences: number;
  issuesWithOpenOccurrences: number;
  totalOpenOccurrences: number;
  issuesNeedingReview: number;
  largestGroupSize: number;
  severityDistribution: Array<DistributionEntry<SeverityBucket>>;
  customerImpactDistribution: Array<DistributionEntry<CustomerImpactBucket>>;
  resolutionStatusDistribution: Array<DistributionEntry<ResolutionStatusBucket>>;
  earliestOccurrence: string | null;
  latestOccurrence: string | null;
}

export interface RecurringIssueReport {
  summary: ReportSummary;
  rankingCriteria: readonly string[];
  issues: RankedGroup[];
}

/**
 * Turns the groups file into a ranked, render-ready model. Pure and
 * deterministic — no API calls, no LLM, no randomness. `asOf` is injected so
 * "days since last occurrence" is testable rather than clock-dependent.
 */
export function buildRecurringIssueReport(groupOutput: GroupOutput, asOf: Date): RecurringIssueReport {
  const analyzed = groupOutput.groups.map((group) => analyzeGroup(group, asOf));
  const issues = rankGroups(analyzed);

  const allOccurrences = issues.flatMap((issue) => issue.occurrences);
  const dates = issues
    .flatMap((issue) => [issue.window.firstSeen, issue.window.lastSeen])
    .filter((value): value is string => value !== null)
    .sort();

  return {
    summary: {
      recurringIssueCount: issues.length,
      totalOccurrences: allOccurrences.length,
      issuesWithOpenOccurrences: issues.filter((issue) => issue.resolution.hasOpenOccurrences).length,
      totalOpenOccurrences: issues.reduce((sum, issue) => sum + issue.resolution.openCount, 0),
      issuesNeedingReview: issues.filter((issue) => issue.needsReview).length,
      largestGroupSize: issues.reduce((max, issue) => Math.max(max, issue.occurrenceCount), 0),
      severityDistribution: distribute(
        allOccurrences.map((occurrence) => occurrence.severity),
        SEVERITY_ORDER,
      ),
      customerImpactDistribution: distribute(
        allOccurrences.map((occurrence) => occurrence.customerImpact),
        CUSTOMER_IMPACT_ORDER,
      ),
      resolutionStatusDistribution: distribute(
        allOccurrences.map((occurrence) => occurrence.resolutionStatus),
        RESOLUTION_STATUS_ORDER,
      ),
      earliestOccurrence: dates[0] ?? null,
      latestOccurrence: dates.at(-1) ?? null,
    },
    rankingCriteria: RANKING_CRITERIA,
    issues,
  };
}
