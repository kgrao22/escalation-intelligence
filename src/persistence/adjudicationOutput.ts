import fs from "node:fs/promises";
import path from "node:path";
import { RELATIONSHIPS } from "../llm/schemas/recurrenceAdjudication.js";
import { WORKFLOW_RELATIONSHIPS, type AnyRelationship } from "../llm/schemas/workflowAdjudication.js";
import { buildDatedFilename } from "./datedFiles.js";

export interface AdjudicationResultSide {
  rootTs: string;
  normalizedProblemStatement: string;
  permalink: string | null;
}

export interface AdjudicationResultItem {
  pairId: string;
  similarity: number;
  a: AdjudicationResultSide;
  b: AdjudicationResultSide;
  status: "success" | "failed";
  relationship?: AnyRelationship;
  confidence?: number;
  reasoning?: string;
  proposedRecurringIssueName?: string | null;
  error?: string;
}

/** Keyed by whichever vocabulary the run used; both tracks share `different`. */
export type RelationshipCounts = Record<string, number>;

export interface AdjudicationRunMetadata {
  embeddingsInputFile: string;
  extractionsInputFile: string;
  createdAt: string;
  model: string;
  promptVersion: string;
  candidateSimilarityFloor: number;
  totalEmbeddingPairs: number;
  candidatePairs: number;
  adjudicated: number;
  failures: number;
  relationshipCounts: RelationshipCounts;
  category?: "technical" | "workflow";
  sourceWindowDays?: number;
}

export interface AdjudicationOutput {
  metadata: AdjudicationRunMetadata;
  results: AdjudicationResultItem[];
}

export function adjudicationOutputFilePath(
  baseDir: string,
  createdAt: Date,
  windowTag?: string | null,
  prefix = "adjudications",
): string {
  return path.join(baseDir, buildDatedFilename(prefix, createdAt, windowTag));
}

export async function writeAdjudicationOutput(output: AdjudicationOutput, filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}

function priorKey(pairId: string, promptVersion: string, model: string): string {
  return `${pairId}::${promptVersion}::${model}`;
}

/**
 * Index of already-adjudicated pairs, keyed by pairId + prompt version +
 * model. Only successes are indexed — a prior failure is always worth
 * retrying. Changing the prompt version or the model produces no match, which
 * correctly forces re-adjudication rather than reusing an answer from a
 * different judge.
 */
export function buildPriorAdjudicationIndex(
  priorOutputs: AdjudicationOutput[],
): Map<string, AdjudicationResultItem> {
  const index = new Map<string, AdjudicationResultItem>();
  for (const output of priorOutputs) {
    for (const result of output.results) {
      if (result.status !== "success") {
        continue;
      }
      index.set(priorKey(result.pairId, output.metadata.promptVersion, output.metadata.model), result);
    }
  }
  return index;
}

export function lookupPriorAdjudication(
  index: Map<string, AdjudicationResultItem>,
  pairId: string,
  promptVersion: string,
  model: string,
): AdjudicationResultItem | undefined {
  return index.get(priorKey(pairId, promptVersion, model));
}

/**
 * Zeroed counts for both vocabularies, so a report always shows every possible
 * verdict — including the ones that did not occur, which is information.
 */
export function emptyRelationshipCounts(): RelationshipCounts {
  const counts: RelationshipCounts = {};
  for (const relationship of [...RELATIONSHIPS, ...WORKFLOW_RELATIONSHIPS]) {
    counts[relationship] = 0;
  }
  return counts;
}

export function countRelationships(results: AdjudicationResultItem[]): RelationshipCounts {
  const counts = emptyRelationshipCounts();
  for (const result of results) {
    if (result.status === "success" && result.relationship) {
      counts[result.relationship] = (counts[result.relationship] ?? 0) + 1;
    }
  }
  return counts;
}
