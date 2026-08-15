import fs from "node:fs/promises";
import path from "node:path";
import type { WorkflowEmbeddingCandidate } from "../workflow/workflowEmbeddingCandidates.js";
import { buildDatedFilename } from "./datedFiles.js";

/** A candidate plus its vector. The statement stays alongside so resumability can key on it. */
export interface WorkflowEmbeddingEntry extends WorkflowEmbeddingCandidate {
  vector: number[];
}

export interface WorkflowEmbeddingRunMetadata {
  inputFile: string;
  createdAt: string;
  sourceWindowDays?: number;
  embeddingModel: string;
  embeddingDimension: number;
  workflowCandidatesAvailable: number;
  successfullyEmbedded: number;
  failed: number;
  workflowClassificationCounts: Record<string, number>;
  extractionPromptVersion: string;
  extractionPromptRevision?: string;
  extractionModel: string;
  /** Always "workflow" — makes a mixed-up file obvious on sight. */
  category: "workflow";
  /** The field these vectors were built from. Recorded so it can never be mistaken. */
  embeddedField: "normalizedWorkflowStatement";
  reusedFromCache: number;
}

export interface WorkflowEmbeddingOutput {
  metadata: WorkflowEmbeddingRunMetadata;
  embeddings: WorkflowEmbeddingEntry[];
}

/** e.g. `workflow-embeddings-180d-2026-08-12.json` — never collides with the technical file. */
export function workflowEmbeddingOutputFilePath(
  baseDir: string,
  createdAt: Date,
  windowTag?: string | null,
): string {
  return path.join(baseDir, buildDatedFilename("workflow-embeddings", createdAt, windowTag));
}

export async function writeWorkflowEmbeddingOutput(
  output: WorkflowEmbeddingOutput,
  filePath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}

/**
 * Resumability key. Includes the statement itself, so an extraction that
 * reworded a workflow produces a different key and is re-embedded rather than
 * silently reusing a vector for text that no longer exists.
 */
export function workflowEmbeddingCacheKey(rootTs: string, statement: string, model: string): string {
  return `${rootTs}::${model}::${statement}`;
}

/**
 * Indexes prior workflow embeddings only. Technical embedding files have a
 * different prefix and a different shape, and a technical vector must never
 * satisfy a workflow lookup even for the same thread — they encode different
 * text.
 */
export function buildWorkflowEmbeddingCache(
  priorOutputs: WorkflowEmbeddingOutput[],
): Map<string, WorkflowEmbeddingEntry> {
  const cache = new Map<string, WorkflowEmbeddingEntry>();
  for (const output of priorOutputs) {
    if (output.metadata?.embeddedField !== "normalizedWorkflowStatement") {
      continue;
    }
    for (const entry of output.embeddings ?? []) {
      if (!Array.isArray(entry.vector) || entry.vector.length === 0) {
        continue;
      }
      cache.set(
        workflowEmbeddingCacheKey(entry.rootTs, entry.statement, output.metadata.embeddingModel),
        entry,
      );
    }
  }
  return cache;
}

export function lookupWorkflowEmbedding(
  cache: Map<string, WorkflowEmbeddingEntry>,
  candidate: WorkflowEmbeddingCandidate,
  model: string,
): WorkflowEmbeddingEntry | undefined {
  return cache.get(workflowEmbeddingCacheKey(candidate.rootTs, candidate.statement, model));
}
