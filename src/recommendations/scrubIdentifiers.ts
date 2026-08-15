/**
 * Defensive redaction applied to every free-text field before it is sent to
 * Claude.
 *
 * The extraction prompt already instructs the model to keep identifiers out
 * of these fields, and calibration suggests it complies — but "the upstream
 * prompt asked nicely" is not a control. These patterns catch the shapes that
 * are unambiguous and cheap to detect, so a slip upstream cannot become an
 * outbound leak.
 *
 * Redaction is deliberately preferred over throwing: a false positive would
 * otherwise block an entire run, and replacing a token still leaves the
 * surrounding technical meaning intact.
 */
const REDACTION_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "EMAIL", pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
  // Stripe-style prefixed object ids (cus_…, sub_…, pi_…, in_…).
  { label: "VENDOR_ID", pattern: /\b(?:cus|sub|pi|ch|in|price|prod|acct|inv|seti|pm)_[A-Za-z0-9]{8,}\b/g },
  { label: "UUID", pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  // Long bare digit runs: card numbers, phone numbers, account numbers.
  { label: "LONG_NUMBER", pattern: /\b\d{9,}\b/g },
];

export interface ScrubResult {
  text: string;
  redactionCount: number;
}

export function scrubIdentifiers(text: string): ScrubResult {
  let redactionCount = 0;
  let scrubbed = text;

  for (const { label, pattern } of REDACTION_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, () => {
      redactionCount += 1;
      return `[${label}_REDACTED]`;
    });
  }

  return { text: scrubbed, redactionCount };
}

export function scrubOptional(text: string | null | undefined): ScrubResult {
  if (text === null || text === undefined || text === "") {
    return { text: "", redactionCount: 0 };
  }
  return scrubIdentifiers(text);
}
