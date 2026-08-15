import type { EmbeddingEntry } from "../persistence/embeddingOutput.js";
import { chunk, countBatches, DEFAULT_EMBEDDING_BATCH_SIZE } from "./batching.js";
import { assertConsistentDimension } from "./cosineSimilarity.js";
import { assertEmbeddingCandidatesSafe, type EmbeddingCandidate } from "./selectCandidates.js";
import { orderBatchEmbeddings, type VoyageEmbedFn } from "./voyageClient.js";

export interface DryRunPlan {
  eligibleCount: number;
  model: string;
  batchSize: number;
  batchCount: number;
}

export function planEmbeddingRun(
  candidates: EmbeddingCandidate[],
  model: string,
  batchSize: number = DEFAULT_EMBEDDING_BATCH_SIZE,
): DryRunPlan {
  return {
    eligibleCount: candidates.length,
    model,
    batchSize,
    batchCount: countBatches(candidates.length, batchSize),
  };
}

export interface EmbedCandidatesParams {
  candidates: EmbeddingCandidate[];
  embedFn: VoyageEmbedFn;
  model: string;
  batchSize?: number;
  onBatchProgress?: (batchIndex: number, batchCount: number, itemsInBatch: number) => void;
}

export interface EmbedCandidatesResult {
  entries: EmbeddingEntry[];
  dimension: number;
}

export async function embedCandidates(params: EmbedCandidatesParams): Promise<EmbedCandidatesResult> {
  const batchSize = params.batchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE;

  // Privacy gate: runs before any network call, on every path.
  assertEmbeddingCandidatesSafe(params.candidates);

  if (params.candidates.length === 0) {
    throw new Error("No eligible technical escalations to embed.");
  }

  const batches = chunk(params.candidates, batchSize);
  const vectors: number[][] = [];

  for (const [batchIndex, batch] of batches.entries()) {
    params.onBatchProgress?.(batchIndex + 1, batches.length, batch.length);

    const response = await params.embedFn({
      model: params.model,
      input: batch.map((candidate) => candidate.normalizedProblemStatement),
    });

    vectors.push(...orderBatchEmbeddings(response, batch.length));
  }

  const dimension = assertConsistentDimension(vectors);

  const entries: EmbeddingEntry[] = params.candidates.map((candidate, index) => ({
    rootTs: candidate.rootTs,
    normalizedProblemStatement: candidate.normalizedProblemStatement,
    classification: candidate.classification,
    permalink: candidate.permalink,
    vector: vectors[index] as number[],
  }));

  return { entries, dimension };
}
