export class UnsafePostTargetError extends Error {
  constructor(destinationChannelId: string, sourceChannelId: string) {
    super(
      `Refusing to post: destination channel (${destinationChannelId}) is the same as ` +
        `the read-only source channel (${sourceChannelId}). The source channel must never ` +
        "receive posts, edits, reactions, or any other mutating call.",
    );
    this.name = "UnsafePostTargetError";
  }
}

/**
 * Explicit, standalone safety guard against ever posting to the source
 * (read-only, production) channel. This is intentionally decoupled from
 * environment validation (see src/config/env.ts, which enforces the same
 * invariant at startup) so the check also protects any future code path
 * that calls chat.postMessage directly with channel IDs from elsewhere
 * (e.g. a config file, a CLI flag, or a different caller) — defense in
 * depth, not reliance on a single check.
 */
export function assertSafePostTarget(params: {
  destinationChannelId: string;
  sourceChannelId: string;
}): void {
  if (params.destinationChannelId === params.sourceChannelId) {
    throw new UnsafePostTargetError(params.destinationChannelId, params.sourceChannelId);
  }
}
