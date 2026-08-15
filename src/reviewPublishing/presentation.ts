/**
 * Presentation helpers for the Slack review. These change only how existing
 * values are displayed — never the values themselves, and never the underlying
 * artifacts.
 */

/** Default cap for a proposal shown in Slack. Long enough to be useful, short enough to scan. */
export const PROPOSAL_MAX_LENGTH = 320;

/**
 * Abbreviations whose trailing period must not be mistaken for a sentence end.
 * Stored without the final period and matched case-insensitively.
 */
const ABBREVIATIONS = new Set([
  "e.g", "i.e", "etc", "vs", "cf", "approx", "no", "fig", "al",
  "dr", "mr", "mrs", "ms", "prof", "inc", "ltd", "co", "st", "jr", "sr",
]);

/** Is the period at `index` a real sentence terminator? */
function isSentenceEnd(text: string, index: number): boolean {
  if (text[index] !== ".") {
    return false;
  }
  // Must be followed by whitespace then something that starts a new sentence.
  const after = text.slice(index + 1);
  if (!/^\s+\S/.test(after)) {
    return false;
  }
  // A digit on either side means a decimal or version, not a sentence end.
  if (/\d/.test(text[index - 1] ?? "") && /^\s*\d/.test(after)) {
    return false;
  }
  // The token ending at this period must not be a known abbreviation. The token
  // may itself contain periods ("e.g"), so walk back over word chars and dots.
  let start = index;
  while (start > 0 && /[A-Za-z.]/.test(text[start - 1] as string)) {
    start -= 1;
  }
  const token = text.slice(start, index).toLowerCase().replace(/^\.+/, "");
  return !ABBREVIATIONS.has(token);
}

/**
 * Deterministic, abbreviation-safe truncation.
 *
 * The previous implementation split on `/[^.]+\./` and turned "(e.g. 1 hour)"
 * into "(e. g." — it treated the period inside an abbreviation as a sentence
 * boundary. This instead prefers the last real sentence end within the limit,
 * falls back to a word boundary, and never cuts mid-word or mid-abbreviation.
 * Proposal wording is otherwise untouched.
 */
export function truncateForSlack(text: string, maxLength: number = PROPOSAL_MAX_LENGTH): string {
  const normalised = text.replace(/\s+/g, " ").trim();
  if (normalised.length <= maxLength) {
    return normalised;
  }

  // Prefer the last complete sentence that fits.
  let lastSentenceEnd = -1;
  for (let i = 0; i < Math.min(normalised.length, maxLength); i += 1) {
    if (isSentenceEnd(normalised, i)) {
      lastSentenceEnd = i;
    }
  }
  if (lastSentenceEnd > 0) {
    return normalised.slice(0, lastSentenceEnd + 1);
  }

  // Otherwise cut at the last word boundary and mark the elision.
  const window = normalised.slice(0, maxLength);
  const lastSpace = window.lastIndexOf(" ");
  const cut = lastSpace > 0 ? window.slice(0, lastSpace) : window;
  return `${cut.replace(/[,;:.]+$/, "")}…`;
}

/** Tokens that carry no distinguishing meaning when comparing system labels. */
const LABEL_STOPWORDS = new Set(["and", "with", "the", "a", "an", "of", "for", "to", "in", "on", "between"]);

function labelTokens(label: string): Set<string> {
  return new Set(
    label
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 0 && !LABEL_STOPWORDS.has(token)),
  );
}

function isSubsetOf(inner: Set<string>, outer: Set<string>): boolean {
  for (const token of inner) {
    if (!outer.has(token)) {
      return false;
    }
  }
  return true;
}

/**
 * Collapses near-duplicate system labels for display.
 *
 * Extraction produced variants of one system across threads — "Stripe
 * integration", "Stripe integration, payment processing", "Payment processing
 * integration with Stripe". Plain substring matching misses those because the
 * words are reordered, so labels are compared as token sets: when one label's
 * significant tokens are a subset of another's, the more specific label is kept.
 *
 * Nothing is invented — every surviving label appears verbatim in the source.
 */
export function normalizeSystemLabels(systems: string[]): string[] {
  const cleaned = systems.map((system) => system.replace(/\s+/g, " ").trim()).filter((system) => system.length > 0);

  // Exact/case-insensitive duplicates: keep the first spelling seen.
  const byLower = new Map<string, string>();
  for (const label of cleaned) {
    const key = label.toLowerCase();
    if (!byLower.has(key)) {
      byLower.set(key, label);
    }
  }
  const unique = [...byLower.values()];

  const survivors = unique.filter((label, index) => {
    const tokens = labelTokens(label);
    if (tokens.size === 0) {
      return false;
    }
    return !unique.some((other, otherIndex) => {
      if (otherIndex === index) {
        return false;
      }
      const otherTokens = labelTokens(other);
      if (!isSubsetOf(tokens, otherTokens)) {
        return false;
      }
      // Equal token sets: keep exactly one — the longer (more specific) label,
      // with index as a deterministic final tie-break.
      if (isSubsetOf(otherTokens, tokens)) {
        return other.length > label.length || (other.length === label.length && otherIndex < index);
      }
      return true;
    });
  });

  // Most informative first (more significant tokens), then alphabetical so the
  // ordering — and therefore which labels land in the "+N more" tail — is stable.
  return survivors.sort(
    (a, b) => labelTokens(b).size - labelTokens(a).size || a.localeCompare(b),
  );
}

/** Maximum system labels rendered inline before the remainder is summarised. */
export const MAX_DISPLAYED_SYSTEMS = 3;

/**
 * Separator between system labels. A middot rather than a comma because the
 * labels themselves frequently contain commas ("Stripe integration, payment
 * processing"), which would make a comma-joined list impossible to read as
 * distinct entries.
 */
export const SYSTEM_SEPARATOR = " · ";

/**
 * Renders at most three systems, summarising any remainder as "+N more" so the
 * reader knows the list was trimmed rather than that only three exist.
 */
export function formatSystems(systems: string[], limit: number = MAX_DISPLAYED_SYSTEMS): string {
  const normalised = normalizeSystemLabels(systems);
  if (normalised.length === 0) {
    return "";
  }
  const shown = normalised.slice(0, limit);
  const remaining = normalised.length - shown.length;
  const joined = shown.join(SYSTEM_SEPARATOR);
  return remaining > 0 ? `${joined} +${remaining} more` : joined;
}

/**
 * Classification labels that describe a bucket rather than an action. When a
 * cluster carries one of these, the label alone cannot distinguish it from the
 * other clusters sharing it — the 365-day review rendered four different
 * actions all as "Backend operational corrections".
 */
const GENERIC_CLASSIFICATIONS = new Set([
  "manual_backend_correction",
  "account_data_update",
  "other_operational_workflow",
  "manual_reconciliation",
]);

/** Adverbs that add nothing to a title. */
const LEADING_ADVERBS = /^(?:manually|automatically|repeatedly|periodically)\s+/i;

/**
 * Words that begin a qualifying clause. Cutting here keeps the action itself
 * ("Extend payment link expiry") and drops the circumstances
 * ("...in backend systems when the link expires before the customer pays").
 */
const CLAUSE_BREAKS = new Set([
  "in", "when", "to", "from", "using", "across", "after", "because", "so",
  "for", "with", "due", "that", "which", "if", "where", "on", "by", "into",
  "before", "during", "via",
]);

/** Soft target; a title may overflow to finish an action phrase. */
const TITLE_MAX_WORDS = 7;
/** Hard ceiling — grammatical completeness never costs more than this. */
const TITLE_HARD_MAX_WORDS = 9;

/**
 * Words that cannot end a title: they promise a continuation that never
 * arrives. "…as paid and update" reads truncated because the conjunction is
 * still waiting for its object.
 */
const CONTINUATION_WORDS = new Set(["and", "or", "to", "for", "with", "of", "in", "on", "the", "a", "an"]);

function isContinuation(word: string | undefined): boolean {
  return word !== undefined && CONTINUATION_WORDS.has(word.toLowerCase().replace(/[^a-z-]/g, ""));
}

/**
 * A concise, distinct, human-readable action title derived deterministically
 * from stored evidence — no LLM.
 *
 * Prefers a specific classification label; falls back to the workflow statement
 * when the label is a generic bucket, so two clusters never render identically.
 */
export function slackDisplayTitle(
  classificationLabel: string,
  classificationKey: string | null | undefined,
  statement: string,
): string {
  if (classificationKey && !GENERIC_CLASSIFICATIONS.has(classificationKey)) {
    return classificationLabel;
  }

  const cleaned = statement.replace(/\s+/g, " ").trim().replace(LEADING_ADVERBS, "");
  if (cleaned.length === 0) {
    return classificationLabel;
  }

  const words: string[] = [];
  let extending = false;
  for (const word of cleaned.split(" ")) {
    const bare = word.toLowerCase().replace(/[^a-z-]/g, "");
    // Never cut on the first two words, or a title becomes a bare verb.
    if (words.length >= 2 && CLAUSE_BREAKS.has(bare)) {
      break;
    }
    words.push(word);
    if (words.length >= TITLE_HARD_MAX_WORDS) {
      break;
    }
    if (words.length >= TITLE_MAX_WORDS && !extending) {
      // A conjunction near the end promises an object that has not arrived
      // yet. Commit to the hard ceiling so the phrase completes, rather than
      // re-checking each word and stopping one short.
      if (isContinuation(words.at(-1)) || isContinuation(words.at(-2))) {
        extending = true;
      } else {
        break;
      }
    }
  }

  // If the ceiling still left a dangling word, drop it rather than ship it.
  while (words.length > 2 && isContinuation(words.at(-1))) {
    words.pop();
  }

  const phrase = words.join(" ").replace(/[,;:.]+$/, "");
  if (phrase.length < 10) {
    return classificationLabel;
  }
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/**
 * Status wording that always reconciles to the occurrence count.
 *
 * The previous phrasing read the manual tally alone and produced
 * "8 occurrences · all 3 manual" for a cluster that was 3 manual and 5 unknown.
 */
export function describeAutomationStatus(
  breakdown: Record<string, number>,
  occurrenceCount: number,
): string {
  const manual = breakdown.manual ?? 0;
  const partial = breakdown.partially_automated ?? 0;
  const automated = breakdown.already_automated ?? 0;
  const unknown = breakdown.unknown ?? 0;

  if (occurrenceCount > 0 && manual === occurrenceCount) {
    return `all ${occurrenceCount} manual`;
  }
  if (manual === 0 && unknown === occurrenceCount && occurrenceCount > 0) {
    return "automation status unclear";
  }

  const parts: string[] = [];
  if (manual > 0) {
    parts.push(unknown > 0 ? `${manual} of ${occurrenceCount} manual` : `${manual} manual`);
  }
  if (partial > 0) {
    parts.push(`${partial} partly automated`);
  }
  if (automated > 0) {
    parts.push(`${automated} already automated`);
  }
  if (unknown > 0) {
    parts.push(`${unknown} unclear`);
  }
  return parts.length === 0 ? "automation status unclear" : parts.join(", ");
}
