/**
 * Slack-facing copy is generated from the review artifact's own evidence, never
 * carried over from the model's prose.
 *
 * The 180-day recommendations contained extrapolations the evidence does not
 * support — "13 manual state transitions per month" for a cluster observed 16
 * times in five months, "two manual backend corrections per week (extrapolated)"
 * for two occurrences 18 days apart, "~1–2 hours of backend work per week" from
 * an invented minutes-per-task. Rewriting prose with regexes would be fragile,
 * so the benefit sentence is constructed deterministically from counts and dates
 * that are actually stored, and `assertNoUnsupportedExtrapolation` fails the
 * build if an unsupported rate or duration ever reaches the copy.
 */

export interface BenefitEvidence {
  occurrenceCount: number;
  firstSeen: string | null;
  lastSeen: string | null;
  automationStatusBreakdown: Record<string, number>;
  windowDays: number | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function spanDays(firstSeen: string | null, lastSeen: string | null): number | null {
  if (!firstSeen || !lastSeen) {
    return null;
  }
  const start = Date.parse(firstSeen);
  const end = Date.parse(lastSeen);
  return Number.isNaN(start) || Number.isNaN(end) ? null : Math.round((end - start) / MS_PER_DAY);
}

/** "six months" reads better than "180 days" for leadership. */
function describeWindow(windowDays: number | null): string {
  if (windowDays === null) {
    return "the review period";
  }
  const months = Math.round(windowDays / 30);
  return months >= 2 ? `${months} months` : `${windowDays} days`;
}

/**
 * Every clause is traceable to a stored field: the occurrence count, the
 * observed span, and the automation-status tally. No rate is projected forward,
 * no duration is assumed, no saving is monetised.
 */
export function buildSlackSafeBenefit(evidence: BenefitEvidence): string {
  const { occurrenceCount, automationStatusBreakdown } = evidence;
  const span = spanDays(evidence.firstSeen, evidence.lastSeen);

  const observed =
    occurrenceCount === 1
      ? "Removes a workflow observed once"
      : `Removes a workflow observed ${occurrenceCount} times`;
  const period = ` in ${describeWindow(evidence.windowDays)}`;
  const spanClause = span !== null && span > 0 ? `, recurring across ${span} days` : "";

  const manual = automationStatusBreakdown.manual ?? 0;
  const partial = automationStatusBreakdown.partially_automated ?? 0;

  let statusClause = "";
  if (manual > 0 && partial > 0) {
    statusClause = ` ${manual} occurrence${manual === 1 ? " was" : "s were"} fully manual and ${partial} partly automated, so this consolidates existing tooling rather than adding another path.`;
  } else if (manual > 0) {
    statusClause = ` All ${manual} recorded occurrence${manual === 1 ? "" : "s"} required manual intervention.`;
  } else if (partial > 0) {
    statusClause = ` Existing partial automation covers ${partial} occurrence${partial === 1 ? "" : "s"} and would be extended rather than replaced.`;
  }

  return `${observed}${period}${spanClause}.${statusClause}`.replace(/\s+/g, " ").trim();
}

/**
 * Patterns that assert a rate, a duration saved, or a monetary value. These are
 * exactly the shapes that appeared in the generated recommendations and cannot
 * be derived from anything the pipeline stores.
 */
const UNSUPPORTED_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "rate per time unit", pattern: /\bper\s+(?:week|month|quarter|year|day|wk|mo|yr)\b/i },
  { label: "annualised/periodic claim", pattern: /\b(?:annually|annualised|annualized|quarterly|monthly|weekly|daily)\b/i },
  // Only a SAVINGS claim, not any duration. "Implement a 24-hour read-only
  // window" is a legitimate design parameter; "saves ~30 minutes per incident"
  // is an invented benefit. Requiring a savings verb nearby separates them.
  {
    label: "hours or minutes saved",
    pattern:
      /\b(?:sav|elimin|reduc|cut|recoup|free)\w*(?:\s+\w+){0,4}\s+~?\d[\d.,]*\s*(?:–|-|—|to)?\s*\d*\s*(?:hours?|hrs?|minutes?|mins?)\b/i,
  },
  { label: "time-to-x reduction claim", pattern: /\bfrom\s+(?:hours?|days?|minutes?)\s+to\s+(?:minutes?|seconds?|hours?)\b/i },
  { label: "explicit extrapolation", pattern: /\bextrapolat(?:ed|ion)\b/i },
  { label: "monetary estimate", pattern: /[$£€]\s?\d|\b(?:ROI|cost savings?|FTE|headcount)\b/i },
  { label: "operator-capacity estimate", pattern: /\boperator[- ]hours?\b/i },
];

export class UnsupportedClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedClaimError";
  }
}

export function findUnsupportedClaims(text: string): string[] {
  return UNSUPPORTED_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
}

/**
 * Gate applied to the whole rendered Slack payload before it is written. A
 * claim the evidence cannot support must never reach a leadership channel, so
 * this throws rather than quietly stripping text.
 */
export function assertNoUnsupportedExtrapolation(text: string, context: string): void {
  const claims = findUnsupportedClaims(text);
  if (claims.length > 0) {
    throw new UnsupportedClaimError(
      `${context} contains unsupported quantitative claims (${claims.join(", ")}). ` +
        "Slack copy must be derived from stored evidence only.",
    );
  }
}

/**
 * The population includes workflow-only and technical+workflow threads, and
 * their automationStatus is not always `manual` — so "manual workflow requests"
 * overstates what was measured.
 */
export function describeWorkflowCandidates(count: number): string {
  return `${count} workflow candidates identified`;
}
