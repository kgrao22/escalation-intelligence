/**
 * Short display names for Slack.
 *
 * The persisted group names come from adjudication and are written for
 * precision, not for a Slack headline — several run to 15+ words. These are
 * hand-written short forms keyed by the exact persisted name.
 *
 * Persisted names are never modified; this is a presentation-only lookup.
 *
 * The fallback is deliberately "use the name unchanged" rather than truncating.
 * Cutting a sentence at N characters produces confident-looking nonsense
 * ("Overly strict document validation blocks email delivery for valid…"),
 * which is worse in a report people act on than a name that is merely long.
 */
const DISPLAY_NAME_BY_PERSISTED_NAME: ReadonlyMap<string, string> = new Map([
  ["Policy cancellation state not fully synchronized across backend systems", "Policy cancellation state sync"],
  [
    "Overly strict document validation blocks email delivery for valid transactions missing insurer-unavailable documents",
    "Policy document validation blocks email",
  ],
  ["Payment link expiration before renewal due date processing window", "Renewal payment link expiry"],
  ["Email synchronization failure to downstream CRM and case management systems", "Email → CRM sync failure"],
  ["Missing automatic quote ID generation in endorsement processing workflow", "Endorsement quote ID generation"],
  [
    "Policy documents email sent without required attachments due to race condition in document upload workflow",
    "Policy document delivery race condition",
  ],
  ["Invoice GST calculation omits GST for certain fee components", "Invoice GST calculation"],
  // Alternate phrasings the adjudicator proposed for the same clusters, so a
  // re-run that picks a different highest-confidence name still shortens.
  ["Policy cancellation status not synchronized across system boundaries", "Policy cancellation state sync"],
  [
    "Policy cancellation state not properly synchronized in backend, blocking repurchase",
    "Policy cancellation state sync",
  ],
]);

export function displayNameFor(persistedName: string | null): string {
  if (persistedName === null || persistedName.trim() === "") {
    return "(unnamed recurring issue)";
  }
  return DISPLAY_NAME_BY_PERSISTED_NAME.get(persistedName) ?? persistedName;
}

/** True when a short form exists; useful for spotting new groups that need one. */
export function hasShortDisplayName(persistedName: string | null): boolean {
  return persistedName !== null && DISPLAY_NAME_BY_PERSISTED_NAME.has(persistedName);
}
