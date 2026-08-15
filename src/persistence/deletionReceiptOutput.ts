import fs from "node:fs/promises";
import path from "node:path";
import type { DeletionTarget } from "../slackCleanup/collectDeletionTargets.js";

export interface DeletionResultItem {
  ts: string;
  kind: DeletionTarget["kind"];
  sourceReceiptFile: string;
  sourceRunId: string;
  /** `already_deleted` is a success: the message is gone, which is the goal. */
  outcome: "deleted" | "already_deleted" | "failed";
  error?: string;
}

export interface DeletionReceipt {
  runId: string;
  windowTag: string;
  channelId: string;
  startedAt: string;
  completedAt: string;
  sourceReceiptFiles: string[];
  requestedCount: number;
  deletedCount: number;
  alreadyDeletedCount: number;
  failureCount: number;
  results: DeletionResultItem[];
}

export function deletionReceiptFilePath(
  baseDir: string,
  windowTag: string,
  completedAt: Date,
  runId: string,
): string {
  const date = completedAt.toISOString().slice(0, 10);
  return path.join(baseDir, `slack-deletion-${windowTag}-${date}-${runId}.json`);
}

export async function writeDeletionReceipt(receipt: DeletionReceipt, filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}
