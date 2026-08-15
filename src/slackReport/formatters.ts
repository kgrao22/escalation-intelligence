import type { AutomationOpportunity, Priority } from "../llm/schemas/issueRecommendation.js";
import type { AnalyzedGroup } from "../report/analyzeGroup.js";

export const PRIORITY_EMOJI: Record<Priority, string> = {
  high: "🔴",
  medium: "🟠",
  low: "🟢",
};

const PRIORITY_LABEL: Record<Priority, string> = {
  high: "High priority",
  medium: "Medium priority",
  low: "Low priority",
};

const AUTOMATION_LABEL: Record<AutomationOpportunity, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  not_applicable: "N/A",
};

export function priorityEmoji(priority: Priority): string {
  return PRIORITY_EMOJI[priority];
}

export function priorityLabel(priority: Priority): string {
  return PRIORITY_LABEL[priority];
}

export function automationLabel(opportunity: AutomationOpportunity): string {
  return `Automation: ${AUTOMATION_LABEL[opportunity]}`;
}

/** Only high and medium opportunities earn the space for a concrete idea. */
export function shouldShowAutomationIdea(opportunity: AutomationOpportunity): boolean {
  return opportunity === "high" || opportunity === "medium";
}

/**
 * Compact resolution posture in plain English — never raw enum names.
 * Examples: "Open: 2 workaround", "Open: 1 unresolved, 1 workaround",
 * "Resolved", "Investigating".
 */
export function statusLine(resolution: AnalyzedGroup["resolution"], totalOccurrences: number): string {
  if (resolution.openCount > 0) {
    const parts: string[] = [];
    if (resolution.unresolvedCount > 0) {
      parts.push(`${resolution.unresolvedCount} unresolved`);
    }
    if (resolution.workaroundCount > 0) {
      parts.push(`${resolution.workaroundCount} workaround`);
    }
    return `Open: ${parts.join(", ")}`;
  }
  if (resolution.resolvedCount === totalOccurrences && totalOccurrences > 0) {
    return "Resolved";
  }
  // Nothing open and not everything resolved: the threads never established
  // an outcome, so the honest label is that it is still being worked out.
  return "Investigating";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Jun 12" in UTC, so output does not vary with the machine's timezone. */
export function formatShortDate(iso: string | null): string | null {
  if (iso === null) {
    return null;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/** "Jun 12 → Jul 22", or a single date when both ends match. */
export function formatDateRange(firstSeen: string | null, lastSeen: string | null): string | null {
  const first = formatShortDate(firstSeen);
  const last = formatShortDate(lastSeen);
  if (first === null && last === null) {
    return null;
  }
  if (first === null || last === null) {
    return first ?? last;
  }
  return first === last ? first : `${first} → ${last}`;
}

export const LOW_CONFIDENCE_THRESHOLD = 0.8;

/**
 * "Confidence: 92%", with a warning marker below the threshold so a reader
 * never mistakes a thinly-evidenced recommendation for a settled one.
 */
export function confidenceLine(confidence: number): string {
  const percent = Math.round(confidence * 100);
  return confidence < LOW_CONFIDENCE_THRESHOLD ? `Confidence: ${percent}% ⚠️` : `Confidence: ${percent}%`;
}

export function pluraliseOccurrences(count: number): string {
  return `${count} occurrence${count === 1 ? "" : "s"}`;
}

/**
 * Slack mrkdwn links to the original threads. Occurrences without a permalink
 * are skipped rather than rendered as dead text, and numbering follows the
 * rendered links so there are no gaps. rootTs is never emitted.
 */
export function evidenceLinks(occurrences: Array<{ permalink: string | null }>): string | null {
  const links = occurrences
    .filter((occurrence): occurrence is { permalink: string } => occurrence.permalink !== null)
    .map((occurrence, index) => `<${occurrence.permalink}|Occurrence ${index + 1}>`);

  return links.length === 0 ? null : links.join(" · ");
}
