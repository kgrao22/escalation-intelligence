/**
 * Slack `subtype` values that represent channel housekeeping/system events
 * rather than user-authored content — never genuine escalation candidates.
 * This is deliberately narrow and subtype-based, not semantic: anything
 * without one of these subtypes is kept, even if it later turns out not to
 * be a real technical escalation (that judgment is a later, LLM-based
 * milestone).
 */
const SYSTEM_NOISE_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "group_join",
  "group_leave",
  "group_topic",
  "group_purpose",
  "group_name",
  "group_archive",
  "group_unarchive",
  "pinned_item",
  "unpinned_item",
]);

export function isSystemNoiseMessage(message: { subtype?: string }): boolean {
  return message.subtype !== undefined && SYSTEM_NOISE_SUBTYPES.has(message.subtype);
}
