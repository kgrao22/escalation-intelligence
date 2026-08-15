import fs from "node:fs/promises";
import path from "node:path";
import type { ReviewData } from "../review/buildReview.js";
import type { RenderedReview } from "../review/renderReview.js";
import { buildDatedFilename } from "./datedFiles.js";

export interface ReviewArtifactMetadata {
  windowTag: string;
  generatedAt: string;
  extractionsInputFile: string;
  workflowClustersInputFile: string;
  workflowRecommendationsInputFile: string;
  technicalReportInputFile: string | null;
  technicalRecurrenceAvailable: boolean;
  /** Fixed marker: this stage reads local artifacts only. */
  externalApiCalls: 0;
}

export interface ReviewArtifact {
  metadata: ReviewArtifactMetadata;
  overview: ReviewData["overview"];
  automationOpportunities: ReviewData["automationOpportunities"];
  recurringWorkflows: ReviewData["recurringWorkflows"];
  technicalIssues: ReviewData["technicalIssues"];
  longTail: ReviewData["longTail"];
  nextActions: ReviewData["nextActions"];
  rendered: RenderedReview;
}

export function reviewArtifactFilePath(
  baseDir: string,
  generatedAt: Date,
  windowTag?: string | null,
): string {
  return path.join(baseDir, buildDatedFilename("review", generatedAt, windowTag));
}

export async function writeReviewArtifact(artifact: ReviewArtifact, filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}
