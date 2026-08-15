import { chunk, countBatches, DEFAULT_EMBEDDING_BATCH_SIZE } from "../embeddings/batching.js";
import { assertConsistentDimension } from "../embeddings/cosineSimilarity.js";
import { orderBatchEmbeddings, type VoyageEmbedFn } from "../embeddings/voyageClient.js";
import type { WorkflowEmbeddingEntry } from "../persistence/workflowEmbeddingOutput.js";
import { lookupWorkflowEmbedding } from "../persistence/workflowEmbeddingOutput.js";
import {
  assertWorkflowPayloadSafe,
  workflowEmbedPayload,
  type WorkflowEmbeddingCandidate,
} from "./workflowEmbeddingCandidates.js";

export interface WorkflowDryRunPlan {
  candidateCount: number;
  toEmbed: number;
  reusable: number;
  model: string;
  batchSize: number;
  batchCount: number;
  totalPayloadChars: number;
  averageCharsPerStatement: number;
  /** Rough ~4-chars-per-token heuristic, not a real tokenizer count. */
  approxTotalTokens: number;
}

export function planWorkflowEmbeddingRun(
  candidates: WorkflowEmbeddingCandidate[],
  model: string,
  cache: Map<string, WorkflowEmbeddingEntry> = new Map(),
  batchSize: number = DEFAULT_EMBEDDING_BATCH_SIZE,
): WorkflowDryRunPlan {
  const reusable = candidates.filter((c) => lookupWorkflowEmbedding(cache, c, model) !== undefined).length;
  const toEmbed = candidates.length - reusable;
  const payload = workflowEmbedPayload(candidates);
  const totalPayloadChars = payload.reduce((sum, text) => sum + text.length, 0);

  return {
    candidateCount: candidates.length,
    toEmbed,
    reusable,
    model,
    batchSize,
    batchCount: countBatches(toEmbed, batchSize),
    totalPayloadChars,
    averageCharsPerStatement: payload.length > 0 ? Math.round(totalPayloadChars / payload.length) : 0,
    approxTotalTokens: Math.round(totalPayloadChars / 4),
  };
}

export interface EmbedWorkflowParams {
  candidates: WorkflowEmbeddingCandidate[];
  embedFn: VoyageEmbedFn;
  model: string;
  cache?: Map<string, WorkflowEmbeddingEntry>;
  batchSize?: number;
  onBatchProgress?: (batchIndex: number, batchCount: number, itemsInBatch: number) => void;
}

export interface EmbedWorkflowResult {
  entries: WorkflowEmbeddingEntry[];
  dimension: number;
  reusedFromCache: number;
  failed: number;
}

/**
 * Embeds the workflow pool, reusing cached vectors keyed on
 * (rootTs + statement + model). Only the statements are transmitted; every
 * other field on the candidate stays local and is re-attached afterwards.
 */
export async function embedWorkflowCandidates(params: EmbedWorkflowParams): Promise<EmbedWorkflowResult> {
  const batchSize = params.batchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE;
  const cache = params.cache ?? new Map<string, WorkflowEmbeddingEntry>();

  // Privacy gate: runs before any network call, on every path.
  assertWorkflowPayloadSafe(params.candidates);

  if (params.candidates.length === 0) {
    throw new Error("No workflow candidates to embed.");
  }

  const vectorByRootTs = new Map<string, number[]>();
  let reusedFromCache = 0;

  const pending: WorkflowEmbeddingCandidate[] = [];
  for (const candidate of params.candidates) {
    const cached = lookupWorkflowEmbedding(cache, candidate, params.model);
    if (cached) {
      vectorByRootTs.set(candidate.rootTs, cached.vector);
      reusedFromCache += 1;
    } else {
      pending.push(candidate);
    }
  }

  const batches = chunk(pending, batchSize);
  for (const [batchIndex, batch] of batches.entries()) {
    params.onBatchProgress?.(batchIndex + 1, batches.length, batch.length);

    const response = await params.embedFn({
      model: params.model,
      // The ONLY data that crosses the network.
      input: workflowEmbedPayload(batch),
    });

    const vectors = orderBatchEmbeddings(response, batch.length);
    for (const [i, candidate] of batch.entries()) {
      vectorByRootTs.set(candidate.rootTs, vectors[i] as number[]);
    }
  }

  const entries: WorkflowEmbeddingEntry[] = [];
  let failed = 0;
  for (const candidate of params.candidates) {
    const vector = vectorByRootTs.get(candidate.rootTs);
    if (!vector) {
      failed += 1;
      continue;
    }
    entries.push({ ...candidate, vector });
  }

  return {
    entries,
    dimension: assertConsistentDimension(entries.map((entry) => entry.vector)),
    reusedFromCache,
    failed,
  };
}
