import {
  EXPECTED_DESTINATION_CHANNEL_ID,
  FORBIDDEN_SOURCE_CHANNEL_ID,
} from "../slackPublishing/safety.js";

export class CleanupSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CleanupSafetyError";
  }
}

/** One message this bot published, as recorded in a local receipt. */
export interface DeletionTarget {
  /** Slack message timestamp — the delete key. */
  ts: string;
  /** "overview" is the thread parent; everything else is a reply. */
  kind: "overview" | "reply";
  channelId: string;
  /** Receipt this target was reconstructed from — its only provenance. */
  sourceReceiptFile: string;
  sourceRunId: string;
}

export interface PublicationReceiptLike {
  runId?: string;
  destinationChannelId?: string;
  overviewTs?: string | null;
  status?: string;
  publishedMessages?: Array<{
    index?: number;
    type?: string;
    slackTs?: string | null;
    status?: string;
  }>;
}

export interface ReceiptFile {
  filename: string;
  receipt: PublicationReceiptLike;
}

/** Only receipts named for this window are ever considered. */
export function receiptMatchesWindow(filename: string, windowTag: string): boolean {
  return new RegExp(`^slack-publication-${windowTag}-\\d{4}-\\d{2}-\\d{2}-[0-9a-f]+\\.json$`).test(filename);
}

/**
 * Rebuilds the exact set of messages this bot published for one window, from
 * local receipts ONLY.
 *
 * There is deliberately no channel search, no text matching, and no message
 * discovery of any kind: a message that is not recorded in a receipt as having
 * been successfully posted by us can never become a deletion target. That is
 * what makes it impossible to delete a human's message, a message from another
 * tool, or anything in the source channel.
 */
export function collectDeletionTargets(files: ReceiptFile[], windowTag: string): DeletionTarget[] {
  const targets: DeletionTarget[] = [];
  const seen = new Set<string>();

  for (const { filename, receipt } of files) {
    if (!receiptMatchesWindow(filename, windowTag)) {
      continue;
    }

    const channelId = receipt.destinationChannelId;
    if (channelId === undefined) {
      continue;
    }
    // A receipt naming the source channel means something is badly wrong;
    // refuse the whole run rather than skipping the row.
    if (channelId === FORBIDDEN_SOURCE_CHANNEL_ID) {
      throw new CleanupSafetyError(
        `Receipt ${filename} names the SOURCE channel ${FORBIDDEN_SOURCE_CHANNEL_ID} as its destination. Refusing to proceed.`,
      );
    }
    if (channelId !== EXPECTED_DESTINATION_CHANNEL_ID) {
      throw new CleanupSafetyError(
        `Receipt ${filename} targets channel ${channelId}, which is not the expected destination ${EXPECTED_DESTINATION_CHANNEL_ID}. Refusing to proceed.`,
      );
    }

    const runId = receipt.runId ?? filename;

    const add = (ts: string | null | undefined, kind: DeletionTarget["kind"]) => {
      if (typeof ts !== "string" || ts.trim() === "" || seen.has(ts)) {
        return;
      }
      seen.add(ts);
      targets.push({ ts, kind, channelId, sourceReceiptFile: filename, sourceRunId: runId });
    };

    for (const message of receipt.publishedMessages ?? []) {
      // Only messages we recorded as successfully posted.
      if (message.status !== "success") {
        continue;
      }
      add(message.slackTs, message.type === "overview" ? "overview" : "reply");
    }

    // The overview may predate the per-message records; include it either way.
    add(receipt.overviewTs, "overview");
  }

  return orderForDeletion(targets);
}

/**
 * Replies first, parent last. Deleting the parent first would orphan the
 * thread and make the remaining replies far harder to find and remove.
 * Within each group, newest first so ordering is stable and reproducible.
 */
export function orderForDeletion(targets: DeletionTarget[]): DeletionTarget[] {
  const byTsDesc = (a: DeletionTarget, b: DeletionTarget) => Number(b.ts) - Number(a.ts);
  return [
    ...targets.filter((target) => target.kind === "reply").sort(byTsDesc),
    ...targets.filter((target) => target.kind === "overview").sort(byTsDesc),
  ];
}

/**
 * Final gate immediately before any live call. Re-checks the channel on every
 * single target rather than trusting the collection step.
 */
export function assertCleanupSafety(targets: DeletionTarget[], windowTag: string): void {
  if (windowTag === "180d") {
    throw new CleanupSafetyError(
      "Refusing to delete 180d publications — this command exists to retire superseded reports, not current ones.",
    );
  }
  for (const target of targets) {
    if (target.channelId === FORBIDDEN_SOURCE_CHANNEL_ID) {
      throw new CleanupSafetyError(`Refusing to delete from the source channel ${FORBIDDEN_SOURCE_CHANNEL_ID}.`);
    }
    if (target.channelId !== EXPECTED_DESTINATION_CHANNEL_ID) {
      throw new CleanupSafetyError(
        `Refusing to delete from ${target.channelId}; only ${EXPECTED_DESTINATION_CHANNEL_ID} is permitted.`,
      );
    }
    if (!/^\d+\.\d+$/.test(target.ts)) {
      throw new CleanupSafetyError(`Refusing to delete malformed timestamp "${target.ts}".`);
    }
    if (!target.sourceReceiptFile) {
      throw new CleanupSafetyError(`Refusing to delete ${target.ts}: no publication receipt provenance.`);
    }
  }
}
