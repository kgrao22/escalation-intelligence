import fs from "node:fs/promises";
import path from "node:path";
import type { SlackMessagePreview } from "../slackReport/renderPreview.js";
import { buildDatedFilename } from "./datedFiles.js";

export interface SlackPreviewMetadata {
  reportInputFile: string;
  recommendationsInputFile: string;
  createdAt: string;
  sourceWindowDays?: number;
  messageCount: number;
  /** Metadata only in this milestone — nothing is sent anywhere. */
  slackDestinationChannelId: string;
  /** Always false here; publication is a later milestone. */
  posted: false;
  omittedGroupIds: string[];
  longestMessageCharacterCount: number;
}

export interface SlackPreviewOutput {
  metadata: SlackPreviewMetadata;
  overview: SlackMessagePreview;
  issues: SlackMessagePreview[];
}

export function slackPreviewOutputFilePath(
  baseDir: string,
  createdAt: Date,
  windowTag?: string | null,
): string {
  return path.join(baseDir, buildDatedFilename("slack-preview", createdAt, windowTag));
}

export async function writeSlackPreviewOutput(
  output: SlackPreviewOutput,
  filePath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}
