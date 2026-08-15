import fs from "node:fs/promises";
import path from "node:path";
import type { RecurringIssueReport } from "../report/buildReport.js";
import type { RecurringWorkflowReport } from "../report/buildWorkflowReport.js";
import { buildDatedFilename } from "./datedFiles.js";

export interface ReportRunMetadata {
  groupsInputFile: string;
  createdAt: string;
  /** Reference instant for "days since last occurrence"; equals createdAt in normal runs. */
  asOf: string;
  sourceWindowDays?: number;
  adjudicationModel: string;
  adjudicationPromptVersion: string;
  candidateSimilarityFloor: number;
  /** Present only when a workflow groups file was found or supplied. */
  workflowGroupsInputFile?: string;
}

export interface ReportOutput {
  metadata: ReportRunMetadata;
  report: RecurringIssueReport;
  /**
   * The manual-workflow track, kept as a sibling of `report` rather than merged
   * into it: workflow recurrence counts must never be added to defect counts.
   * Absent when no workflow groups file exists.
   */
  workflowReport?: RecurringWorkflowReport;
}

export function reportOutputFilePath(baseDir: string, createdAt: Date, windowTag?: string | null): string {
  return path.join(baseDir, buildDatedFilename("report", createdAt, windowTag));
}

export async function writeReportOutput(output: ReportOutput, filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}
