/**
 * Deterministic, human-facing labels. The report goes to leadership, so it
 * never shows raw enum values, and it never invents a name at render time —
 * every label here is a fixed mapping that produces identical output on every
 * run.
 */
const WORKFLOW_CLASSIFICATION_DISPLAY_NAMES: Record<string, string> = {
  customer_identity_update: "Customer identity & email updates",
  policy_state_change: "Policy lifecycle management",
  policy_cancellation: "Policy cancellation",
  policy_reactivation: "Policy reactivation",
  account_data_update: "Account data updates",
  manual_backend_correction: "Backend operational corrections",
  access_or_permission_change: "Access & permission changes",
  manual_reconciliation: "Manual reconciliation",
  manual_document_operation: "Document generation & corrections",
  other_operational_workflow: "Other operational work",
};

const AUTOMATION_STATUS_DISPLAY_NAMES: Record<string, string> = {
  manual: "fully manual",
  partially_automated: "partly automated",
  already_automated: "already automated",
  unknown: "unclear",
};

const RECOMMENDED_ACTION_DISPLAY_NAMES: Record<string, string> = {
  self_service_tooling: "Build self-service tooling",
  internal_admin_tool: "Build an internal admin tool",
  process_automation: "Automate the process",
  permanent_code_fix: "Fix the underlying defect",
  monitoring_or_alerting: "Add monitoring or alerting",
  documentation_or_training: "Document or train",
  keep_manual: "Keep manual",
  investigate_first: "Investigate before building",
};

/** Turns an unmapped enum into readable words rather than showing snake_case. */
function humanise(value: string): string {
  const spaced = value.replace(/_/g, " ").trim();
  return spaced.length === 0 ? value : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function workflowClassificationDisplayName(value: string | null | undefined): string {
  if (!value) {
    return "Uncategorised operational work";
  }
  return WORKFLOW_CLASSIFICATION_DISPLAY_NAMES[value] ?? humanise(value);
}

export function automationStatusDisplayName(value: string): string {
  return AUTOMATION_STATUS_DISPLAY_NAMES[value] ?? humanise(value);
}

export function recommendedActionDisplayName(value: string | null | undefined): string {
  if (!value) {
    return "No recommendation recorded";
  }
  return RECOMMENDED_ACTION_DISPLAY_NAMES[value] ?? humanise(value);
}

/** Words that read as truncation artefacts if a title ends on them. */
const TRAILING_STOP_WORDS = new Set([
  "to", "across", "back", "for", "when", "using", "and", "or", "of", "in",
  "from", "with", "the", "a", "an", "into", "on", "by", "after", "so", "that",
  "their", "its", "this", "as", "at", "is", "are", "be",
]);

/**
 * A short title derived from existing data — the classification label plus a
 * trimmed opening phrase of the representative statement. Deterministic by
 * construction: no generation, no LLM, same input always yields the same
 * title. Truncation happens on a word boundary and trailing function words are
 * dropped, so a title never ends mid-thought.
 */
export function deriveWorkflowTitle(
  classification: string | null | undefined,
  representativeStatement: string,
  maxPhraseLength = 58,
): string {
  const label = workflowClassificationDisplayName(classification);
  const statement = representativeStatement.trim().replace(/[.\s]+$/, "");
  if (statement.length === 0) {
    return label;
  }

  let phrase = statement;
  let truncated = false;
  if (phrase.length > maxPhraseLength) {
    const cut = phrase.slice(0, maxPhraseLength);
    const lastSpace = cut.lastIndexOf(" ");
    phrase = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
    truncated = true;
  }

  const words = phrase.split(/\s+/);
  while (words.length > 3 && TRAILING_STOP_WORDS.has((words.at(-1) as string).toLowerCase())) {
    words.pop();
    truncated = true;
  }
  phrase = words.join(" ").replace(/[,;:]$/, "");

  if (phrase.length < 12) {
    return label;
  }
  return `${label} — ${phrase}${truncated ? "…" : ""}`;
}

export function formatStatusBreakdown(breakdown: Record<string, number>): string {
  const entries = Object.entries(breakdown);
  if (entries.length === 0) {
    return "not recorded";
  }
  return entries.map(([status, count]) => `${count} ${automationStatusDisplayName(status)}`).join(", ");
}

/**
 * Human-facing review period, derived from the window rather than hardcoded so
 * a 90/180/365-day run each labels itself correctly. Months are rounded from
 * days (365 → 12, 180 → 6, 90 → 3); anything under ~2 months stays in days.
 */
export function reviewPeriodLabel(windowDays: number | null): string {
  if (windowDays === null || !Number.isFinite(windowDays) || windowDays <= 0) {
    return "Escalation Review";
  }
  const months = Math.round(windowDays / 30);
  return months >= 2 ? `${months} Month Review` : `${windowDays} Day Review`;
}

export function reviewTitle(windowDays: number | null): string {
  return `Escalation Intelligence — ${reviewPeriodLabel(windowDays)}`;
}
