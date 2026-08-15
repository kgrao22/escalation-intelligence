import fs from "node:fs/promises";
import path from "node:path";
import type { ReviewPreviewArtifact } from "../reviewPublishing/buildReviewPreview.js";
import { buildDatedFilename } from "./datedFiles.js";

export function reviewPreviewFilePath(
  baseDir: string,
  generatedAt: Date,
  windowTag?: string | null,
): string {
  return path.join(baseDir, buildDatedFilename("review-slack-preview", generatedAt, windowTag));
}

export async function writeReviewPreview(
  artifact: ReviewPreviewArtifact,
  filePath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}
