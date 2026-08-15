import fs from "node:fs/promises";
import path from "node:path";
import type { ReviewBucketSummary } from "../review/selectReviewPairs.js";
import { buildDatedFilename } from "./datedFiles.js";

/** Filled in by a human. `null` means "not yet reviewed". */
export type SameUnderlyingIssue = boolean | "unsure" | null;

export interface ReviewPairSide {
  rootTs: string;
  normalizedProblemStatement: string;
  permalink: string | null;
}

export interface ReviewPair {
  /** Order-independent identity, so a labelled pair can be matched back later. */
  pairId: string;
  bucket: string;
  similarity: number;
  a: ReviewPairSide;
  b: ReviewPairSide;
  sameUnderlyingIssue: SameUnderlyingIssue;
  reviewerNotes: string;
}

export interface ReviewRunMetadata {
  inputFile: string;
  createdAt: string;
  embeddingModel: string;
  embeddingDimension: number;
  sourceWindowDays?: number;
  totalTechnicalEscalations: number;
  totalUniquePairs: number;
  reviewPairCount: number;
  maxPerBucket: number;
  topBucketCap: number;
  buckets: ReviewBucketSummary[];
}

export interface ReviewOutput {
  metadata: ReviewRunMetadata;
  instructions: string[];
  pairs: ReviewPair[];
}

export const REVIEW_INSTRUCTIONS: string[] = [
  "For each pair, decide whether A and B describe the SAME underlying recurring issue.",
  "Set sameUnderlyingIssue to true, false, or \"unsure\". Leave it null if not yet reviewed.",
  "Use reviewerNotes for anything that explains a borderline call.",
  "Open the permalinks to check the original Slack threads when the statements alone are ambiguous.",
  "Do not try to infer a similarity cutoff while labelling — label on the substance of the issue.",
  "These labels are the evidence a recurrence threshold will be chosen from afterwards.",
];

export function reviewOutputFilePath(baseDir: string, createdAt: Date, windowTag?: string | null): string {
  return path.join(baseDir, buildDatedFilename("similarity-review", createdAt, windowTag));
}

export async function writeReviewOutput(output: ReviewOutput, filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}
