/**
 * The only channel this application is ever permitted to write to.
 *
 * Resolved ONCE at module load from the environment, never from a CLI flag.
 * That distinction is the safety property: a flag can be mistyped at the
 * moment of running a destructive command, whereas the destination here is
 * fixed for the whole process and re-checked on every single write by
 * `assertWriteTarget`. Redirecting output therefore takes a deliberate
 * environment change, not an accidental keystroke.
 *
 * The placeholder default keeps the repository free of any real workspace's
 * channel IDs; set SLACK_DEST_CHANNEL_ID in .env.local for real use.
 */
export const EXPECTED_DESTINATION_CHANNEL_ID =
  process.env.SLACK_DEST_CHANNEL_ID ?? "C0DEST00000";

/**
 * The production escalations channel. It is the system's read-only source and
 * must never receive a write of any kind. Startup validation additionally
 * refuses to run if this equals the destination.
 */
export const FORBIDDEN_SOURCE_CHANNEL_ID =
  process.env.SLACK_SOURCE_CHANNEL_ID ?? "C0SOURCE0000";

export class PublicationSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationSafetyError";
  }
}

export interface PublicationSafetyInput {
  destinationChannelId: string;
  sourceChannelId: string;
  previewDestinationChannelId: string;
  previewPosted: boolean;
}

/**
 * Runs every precondition before a publication run may begin. Any failure
 * aborts — there is no override flag, by design.
 */
export function assertPublicationSafety(input: PublicationSafetyInput): void {
  if (input.destinationChannelId === input.sourceChannelId) {
    throw new PublicationSafetyError(
      `Destination channel (${input.destinationChannelId}) is the same as the read-only source channel. Refusing to publish.`,
    );
  }

  if (input.destinationChannelId !== EXPECTED_DESTINATION_CHANNEL_ID) {
    throw new PublicationSafetyError(
      `Destination channel is ${input.destinationChannelId}, but this application may only publish to ${EXPECTED_DESTINATION_CHANNEL_ID}. Refusing to publish.`,
    );
  }

  if (input.sourceChannelId !== FORBIDDEN_SOURCE_CHANNEL_ID) {
    throw new PublicationSafetyError(
      `Configured source channel is ${input.sourceChannelId}, expected ${FORBIDDEN_SOURCE_CHANNEL_ID}. Configuration does not match the reviewed setup; refusing to publish.`,
    );
  }

  if (input.previewDestinationChannelId !== input.destinationChannelId) {
    throw new PublicationSafetyError(
      `Preview artifact targets ${input.previewDestinationChannelId} but configuration targets ${input.destinationChannelId}. Refusing to publish a preview built for a different channel.`,
    );
  }

  if (input.previewPosted !== false) {
    throw new PublicationSafetyError(
      "Preview artifact is already marked as posted. Generate a fresh preview rather than republishing this one.",
    );
  }
}

/**
 * Per-write guard, applied immediately before every individual Slack call.
 *
 * Deliberately redundant with assertPublicationSafety: a future refactor that
 * bypassed the run-level check would still be stopped here, one call at a time.
 */
export function assertWriteTarget(channelId: string): void {
  if (channelId === FORBIDDEN_SOURCE_CHANNEL_ID) {
    throw new PublicationSafetyError(
      `Refusing to write to ${channelId}: that is the read-only source channel.`,
    );
  }
  if (channelId !== EXPECTED_DESTINATION_CHANNEL_ID) {
    throw new PublicationSafetyError(
      `Refusing to write to ${channelId}: the only permitted destination is ${EXPECTED_DESTINATION_CHANNEL_ID}.`,
    );
  }
}
