import fs from "node:fs/promises";
import path from "node:path";
import type { RecurringIssueGroup } from "../groups/buildGroups.js";
import { buildDatedFilename } from "./datedFiles.js";

export interface GroupRunMetadata {
  adjudicationInputFile: string;
  extractionInputFile: string;
  sourceWindowDays?: number;
  createdAt: string;
  adjudicationModel: string;
  adjudicationPromptVersion: string;
  candidateSimilarityFloor: number;
  adjudicatedPairs: number;
  sameEdges: number;
  relatedEdges: number;
  differentEdges: number;
  candidateComponents: number;
  recurringGroups: number;
  conflictedComponents: number;
  overlappingGroups: number;
  overlappingMembers: Array<{ member: string; groupIds: string[] }>;
  /**
   * Recurrence frequency is derived from SAME_UNDERLYING_ISSUE only. RELATED
   * pairs are counted for future higher-level problem families but never
   * contribute to a recurring group.
   */
  relatedPairCount: number;
  category?: "technical" | "workflow";
}

export interface GroupOutput {
  metadata: GroupRunMetadata;
  groups: RecurringIssueGroup[];
}

export function groupOutputFilePath(
  baseDir: string,
  createdAt: Date,
  windowTag?: string | null,
  prefix = "groups",
): string {
  return path.join(baseDir, buildDatedFilename(prefix, createdAt, windowTag));
}

export async function writeGroupOutput(output: GroupOutput, filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}
