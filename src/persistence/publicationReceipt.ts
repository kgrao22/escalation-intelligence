import fs from "node:fs/promises";
import path from "node:path";

export type PublicationStatus = "completed" | "partial_failure" | "failed";

export interface PublishedMessageRecord {
  index: number;
  type: "overview" | "issue";
  groupId?: string;
  slackTs: string;
  status: "success";
}

export interface PublicationFailureRecord {
  index: number;
  type: "overview" | "issue";
  groupId?: string;
  error: string;
}

export interface PublicationReceipt {
  runId: string;
  previewInputFile: string;
  destinationChannelId: string;
  startedAt: string;
  completedAt: string | null;
  overviewTs: string | null;
  status: PublicationStatus;
  /** Messages this run attempted — may be a deliberate subset via --limit. */
  requestedMessageCount: number;
  publishedMessages: PublishedMessageRecord[];
  failures: PublicationFailureRecord[];

  // Added after the first live run. Optional so receipts written before they
  // existed still parse; completeness is always recomputed from published
  // indexes rather than trusted from these fields.
  /** Total messages in the preview, independent of what this run attempted. */
  availableMessageCount?: number;
  publishedMessageCount?: number;
  /**
   * Whether the whole preview is published as of this run — NOT whether this
   * run's own plan succeeded. A successful `--limit=1` run is `status:
   * "completed"` but `publicationCompleteForPreview: false`.
   */
  publicationCompleteForPreview?: boolean;
  /** Set when this run continued an earlier publication. */
  isResume?: boolean;
  resumedFromRunId?: string;
}

export function publicationReceiptFilePath(
  baseDir: string,
  createdAt: Date,
  runId: string,
  windowTag?: string | null,
): string {
  const tagSegment = windowTag ? `-${windowTag}` : "";
  const dateStr = createdAt.toISOString().slice(0, 10);
  return path.join(baseDir, `slack-publication${tagSegment}-${dateStr}-${runId}.json`);
}

export async function writePublicationReceipt(
  receipt: PublicationReceipt,
  filePath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

export function receiptsForPreview(
  receipts: PublicationReceipt[],
  previewInputFile: string,
  destinationChannelId: string,
): PublicationReceipt[] {
  return receipts.filter(
    (receipt) =>
      receipt.previewInputFile === previewInputFile &&
      receipt.destinationChannelId === destinationChannelId,
  );
}

/**
 * Every preview message index that has successfully landed, across all runs.
 *
 * A Set, so an index recorded in more than one receipt is counted once — the
 * union is what matters, not any single run's view.
 */
export function collectPublishedIndexes(receipts: PublicationReceipt[]): Set<number> {
  const indexes = new Set<number>();
  for (const receipt of receipts) {
    for (const message of receipt.publishedMessages) {
      if (message.status === "success") {
        indexes.add(message.index);
      }
    }
  }
  return indexes;
}

/**
 * Backward compatibility for receipts written before
 * `publicationCompleteForPreview` existed.
 *
 * Prefers the explicit field when present. Otherwise infers: a run that
 * deliberately requested fewer messages than the preview contains cannot have
 * completed it. No manual editing of old receipts is required.
 */
export function receiptIndicatesCompletePublication(
  receipt: PublicationReceipt,
  availableMessageCount: number,
): boolean {
  if (typeof receipt.publicationCompleteForPreview === "boolean") {
    return receipt.publicationCompleteForPreview;
  }
  if (receipt.requestedMessageCount < availableMessageCount) {
    return false;
  }
  return receipt.status === "completed";
}

export interface PublicationState {
  receipts: PublicationReceipt[];
  publishedIndexes: Set<number>;
  publishedMessageCount: number;
  /** Thread root to reply into, from the most recent receipt that has one. */
  overviewTs: string | null;
  /** Which run supplied that thread root, for traceable output. */
  overviewTsFromRunId: string | null;
  overviewPublished: boolean;
  hasPriorPublication: boolean;
  fullyPublished: boolean;
  missingIndexes: number[];
}

/**
 * The authoritative view of what has already been published for a preview.
 *
 * Completeness is computed from the union of successfully published indexes
 * against the live preview's message count — never from a single receipt's
 * `status`, which only describes whether that run's own (possibly limited)
 * plan succeeded.
 */
export function analysePublicationState(
  allReceipts: PublicationReceipt[],
  previewInputFile: string,
  destinationChannelId: string,
  availableMessageCount: number,
): PublicationState {
  const receipts = receiptsForPreview(allReceipts, previewInputFile, destinationChannelId);
  const publishedIndexes = collectPublishedIndexes(receipts);

  const missingIndexes: number[] = [];
  for (let index = 1; index <= availableMessageCount; index++) {
    if (!publishedIndexes.has(index)) {
      missingIndexes.push(index);
    }
  }

  // Latest receipt carrying a thread root wins; failed runs record none.
  const overviewSource =
    [...receipts]
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .reverse()
      .find((receipt) => typeof receipt.overviewTs === "string" && receipt.overviewTs !== "") ?? null;

  return {
    receipts,
    publishedIndexes,
    publishedMessageCount: publishedIndexes.size,
    overviewTs: overviewSource?.overviewTs ?? null,
    overviewTsFromRunId: overviewSource?.runId ?? null,
    overviewPublished: publishedIndexes.has(1),
    hasPriorPublication: publishedIndexes.size > 0,
    fullyPublished: availableMessageCount > 0 && missingIndexes.length === 0,
    missingIndexes,
  };
}
