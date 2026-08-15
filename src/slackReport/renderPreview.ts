import type { RecommendationOutput, RecommendationResultItem } from "../persistence/recommendationOutput.js";
import type { ReportOutput } from "../persistence/reportOutput.js";
import type { RankedGroup } from "../report/rankGroups.js";
import { displayNameFor } from "./displayNames.js";
import {
  automationLabel,
  confidenceLine,
  evidenceLinks,
  formatDateRange,
  pluraliseOccurrences,
  priorityEmoji,
  priorityLabel,
  shouldShowAutomationIdea,
  statusLine,
} from "./formatters.js";

export class PreviewJoinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewJoinError";
  }
}

export interface SlackMessagePreview {
  text: string;
  groupId?: string;
  characterCount: number;
}

export interface SlackReportPreview {
  overview: SlackMessagePreview;
  issues: SlackMessagePreview[];
  /** Issues whose recommendation failed upstream, omitted from the report. */
  omittedGroupIds: string[];
}

export interface JoinedIssue {
  issue: RankedGroup;
  recommendation: RecommendationResultItem;
}

const REQUIRED_RECOMMENDATION_FIELDS = [
  "recommendedAction",
  "priority",
  "engineeringRecommendation",
  "evidenceSummary",
  "automationOpportunity",
] as const;

function assertNoDuplicateIds(ids: string[], label: string): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      duplicates.add(id);
    }
    seen.add(id);
  }
  if (duplicates.size > 0) {
    throw new PreviewJoinError(`Duplicate groupIds in ${label}: ${[...duplicates].sort().join(", ")}`);
  }
}

/**
 * Joins the deterministic report to its recommendations by groupId,
 * preserving the report's ranking order.
 *
 * Failures are loud rather than silently dropped: a recommendation for an
 * unknown group means the two files came from different runs, and a
 * successful recommendation missing a field it needs would render as a blank
 * section in a report people act on.
 */
export function joinReportAndRecommendations(
  report: ReportOutput,
  recommendations: RecommendationOutput,
): { joined: JoinedIssue[]; omittedGroupIds: string[] } {
  const issues = report.report.issues;
  assertNoDuplicateIds(issues.map((issue) => issue.groupId), "the report");
  assertNoDuplicateIds(recommendations.results.map((result) => result.groupId), "the recommendations");

  const issueById = new Map(issues.map((issue) => [issue.groupId, issue]));

  for (const result of recommendations.results) {
    if (!issueById.has(result.groupId)) {
      throw new PreviewJoinError(
        `Recommendation references groupId ${result.groupId}, which is not in the report. ` +
          "The report and recommendations files are probably from different runs.",
      );
    }
  }

  const recommendationById = new Map(recommendations.results.map((result) => [result.groupId, result]));
  const joined: JoinedIssue[] = [];
  const omittedGroupIds: string[] = [];

  for (const issue of issues) {
    const recommendation = recommendationById.get(issue.groupId);
    if (!recommendation || recommendation.status !== "success") {
      omittedGroupIds.push(issue.groupId);
      continue;
    }

    const missing = REQUIRED_RECOMMENDATION_FIELDS.filter(
      (field) => recommendation[field] === undefined || recommendation[field] === null,
    );
    if (missing.length > 0) {
      throw new PreviewJoinError(
        `Successful recommendation for ${issue.groupId} is missing required field(s): ${missing.join(", ")}`,
      );
    }
    if (typeof recommendation.confidence !== "number") {
      throw new PreviewJoinError(
        `Successful recommendation for ${issue.groupId} is missing required field(s): confidence`,
      );
    }

    joined.push({ issue, recommendation });
  }

  return { joined, omittedGroupIds };
}

/**
 * Human-readable label for the channel that was analysed. Deliberately not
 * hardcoded: the channel name is deployment-specific, and baking a real one
 * into source would publish it to anyone reading the repository. Callers pass
 * their own; the default keeps the sentence grammatical without naming anything.
 */
export const DEFAULT_SOURCE_CHANNEL_LABEL = "the escalations channel";

export interface OverviewInputs {
  sourceWindowDays?: number;
  /** Total technical escalations analysed; omitted from the report when unknown. */
  totalTechnicalEscalations?: number;
  /** Channel label for the summary line. Defaults to a generic phrase. */
  sourceChannelLabel?: string;
}

export function renderOverview(joined: JoinedIssue[], inputs: OverviewInputs): string {
  const totalOccurrences = joined.reduce((sum, entry) => sum + entry.issue.occurrenceCount, 0);
  const openIssues = joined.filter((entry) => entry.issue.resolution.hasOpenOccurrences).length;
  const highAutomation = joined.filter(
    (entry) => entry.recommendation.automationOpportunity === "high",
  ).length;

  const windowLabel = inputs.sourceWindowDays ? `${inputs.sourceWindowDays} Day Review` : "Review";

  const bullets = [
    inputs.totalTechnicalEscalations !== undefined
      ? `• ${inputs.totalTechnicalEscalations} technical escalations identified`
      : null,
    `• ${joined.length} confirmed recurring issue pattern${joined.length === 1 ? "" : "s"}`,
    `• ${totalOccurrences} occurrences across those patterns`,
    `• ${openIssues} recurring issue${openIssues === 1 ? "" : "s"} still have open/workaround occurrences`,
    `• ${highAutomation} high automation opportunit${highAutomation === 1 ? "y" : "ies"}`,
  ].filter((line): line is string => line !== null);

  // Every line carries the unit. The spec's example abbreviated after the
  // first entry, but a bare trailing number reads like a formatting bug in a
  // real message.
  const ranked = joined.map(
    (entry, index) =>
      `${index + 1}. ${priorityEmoji(entry.recommendation.priority!)} ${displayNameFor(entry.issue.name)} — ` +
      pluraliseOccurrences(entry.issue.occurrenceCount),
  );

  const windowPhrase = inputs.sourceWindowDays ? `${inputs.sourceWindowDays} days` : "recent activity";

  return [
    `*Escalation Intelligence — ${windowLabel}*`,
    "",
    `Analysed ${windowPhrase} of ${inputs.sourceChannelLabel ?? DEFAULT_SOURCE_CHANNEL_LABEL}.`,
    "",
    ...bullets,
    "",
    "*Top recurring issues*",
    ...ranked,
  ].join("\n");
}

export function renderIssue(entry: JoinedIssue, rank: number): string {
  const { issue, recommendation } = entry;
  const priority = recommendation.priority!;
  const opportunity = recommendation.automationOpportunity!;

  const headerBits = [
    pluraliseOccurrences(issue.occurrenceCount),
    priorityLabel(priority),
    automationLabel(opportunity),
  ].join(" · ");

  const dateRange = formatDateRange(issue.window.firstSeen, issue.window.lastSeen);
  const status = statusLine(issue.resolution, issue.occurrenceCount);
  const links = evidenceLinks(issue.occurrences);

  const lines: string[] = [
    `*${rank}. ${displayNameFor(issue.name)}* ${priorityEmoji(priority)}`,
    "",
    headerBits,
    [dateRange, status].filter((value): value is string => value !== null).join(" · "),
    "",
    "*Pattern*",
    recommendation.evidenceSummary!,
    "",
    "*Recommended action*",
    recommendation.engineeringRecommendation!,
  ];

  if (shouldShowAutomationIdea(opportunity) && recommendation.automationIdea) {
    lines.push("", "*Automation opportunity*", recommendation.automationIdea);
  }

  if (links !== null) {
    lines.push("", "*Evidence*", links);
  }

  lines.push("", confidenceLine(recommendation.confidence!));

  return lines.join("\n");
}

export function renderSlackReportPreview(
  report: ReportOutput,
  recommendations: RecommendationOutput,
  inputs: OverviewInputs = {},
): SlackReportPreview {
  const { joined, omittedGroupIds } = joinReportAndRecommendations(report, recommendations);

  const overviewText = renderOverview(joined, {
    sourceWindowDays: inputs.sourceWindowDays ?? report.metadata.sourceWindowDays,
    ...(inputs.totalTechnicalEscalations !== undefined
      ? { totalTechnicalEscalations: inputs.totalTechnicalEscalations }
      : {}),
  });

  return {
    overview: { text: overviewText, characterCount: overviewText.length },
    issues: joined.map((entry, index) => {
      const text = renderIssue(entry, index + 1);
      return { text, groupId: entry.issue.groupId, characterCount: text.length };
    }),
    omittedGroupIds,
  };
}
