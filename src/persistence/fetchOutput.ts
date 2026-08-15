import fs from "node:fs/promises";
import path from "node:path";
import type { EscalationThread } from "../slack/escalationThreads.js";
import { buildDatedFilename, windowTagForDays } from "./datedFiles.js";

export interface FetchRunMetadata {
  channelId: string;
  daysBack: number;
  fetchedAt: string;
  rawTopLevelMessages: number;
  systemMessagesFiltered: number;
  analysisThreads: number;
  threadsWithReplies: number;
  totalReplies: number;
}

export interface FetchOutput {
  metadata: FetchRunMetadata;
  threads: EscalationThread[];
}

/**
 * Includes the lookback window in the filename so a 30-day and a 90-day
 * fetch on the same day never collide, e.g. `escalations-90d-2026-08-09.json`.
 */
export function outputFilePath(baseDir: string, fetchedAt: Date, daysBack: number): string {
  return path.join(baseDir, buildDatedFilename("escalations", fetchedAt, windowTagForDays(daysBack)));
}

export async function writeFetchOutput(output: FetchOutput, filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}
