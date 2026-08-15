import fs from "node:fs/promises";
import path from "node:path";
import type { WorkflowRelationship } from "../llm/schemas/workflowAdjudication.js";
import type { WorkflowPairSideLocal } from "../workflow/workflowCandidatePairs.js";
import { buildDatedFilename } from "./datedFiles.js";

export interface WorkflowAdjudicationResultItem {
  pairId: string;
  similarity: number;
  /** Local metadata, including rootTs and permalink — never sent to the LLM. */
  a: WorkflowPairSideLocal;
  b: WorkflowPairSideLocal;
  sameClassification: boolean;
  status: "success" | "failed";
  relationship?: WorkflowRelationship;
  confidence?: number;
  reasoning?: string;
  proposedWorkflowName?: string | null;
  error?: string;
}

export interface WorkflowAdjudicationRunMetadata {
  inputFile: string;
  createdAt: string;
  sourceWindowDays?: number;
  similarityFloor: number;
  totalEmbeddings: number;
  possiblePairs: number;
  candidatePairs: number;
  adjudicatedPairs: number;
  sameUnderlyingWorkflow: number;
  relatedWorkflowFamily: number;
  different: number;
  failed: number;
  reusedFromCache: number;
  crossClassificationCandidates: number;
  model: string;
  promptVersion: string;
  category: "workflow";
}

export interface WorkflowAdjudicationOutput {
  metadata: WorkflowAdjudicationRunMetadata;
  results: WorkflowAdjudicationResultItem[];
}

export function workflowAdjudicationOutputFilePath(
  baseDir: string,
  createdAt: Date,
  windowTag?: string | null,
): string {
  return path.join(baseDir, buildDatedFilename("workflow-adjudications", createdAt, windowTag));
}

export async function writeWorkflowAdjudicationOutput(
  output: WorkflowAdjudicationOutput,
  filePath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}

/** Resumability key: canonical pair id + prompt version + model. */
export function workflowAdjudicationCacheKey(pairId: string, promptVersion: string, model: string): string {
  return `${pairId}::${promptVersion}::${model}`;
}

/**
 * Indexes prior successes only. A failed attempt is always worth retrying, and
 * a verdict from a different prompt version or model is not interchangeable.
 */
export function buildWorkflowAdjudicationCache(
  priorOutputs: WorkflowAdjudicationOutput[],
): Map<string, WorkflowAdjudicationResultItem> {
  const cache = new Map<string, WorkflowAdjudicationResultItem>();
  for (const output of priorOutputs) {
    const { promptVersion, model } = output.metadata ?? {};
    if (!promptVersion || !model) {
      continue;
    }
    for (const result of output.results ?? []) {
      if (result.status !== "success" || result.relationship === undefined) {
        continue;
      }
      cache.set(workflowAdjudicationCacheKey(result.pairId, promptVersion, model), result);
    }
  }
  return cache;
}

export function lookupWorkflowAdjudication(
  cache: Map<string, WorkflowAdjudicationResultItem>,
  pairId: string,
  promptVersion: string,
  model: string,
): WorkflowAdjudicationResultItem | undefined {
  return cache.get(workflowAdjudicationCacheKey(pairId, promptVersion, model));
}

export function countWorkflowRelationships(results: WorkflowAdjudicationResultItem[]): {
  sameUnderlyingWorkflow: number;
  relatedWorkflowFamily: number;
  different: number;
} {
  const tally = (value: WorkflowRelationship) =>
    results.filter((result) => result.status === "success" && result.relationship === value).length;
  return {
    sameUnderlyingWorkflow: tally("same_underlying_workflow"),
    relatedWorkflowFamily: tally("related_workflow_family"),
    different: tally("different"),
  };
}
