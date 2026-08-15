import type { RetryOptions } from "../llm/retry.js";
import type { AdjudicationResultItem } from "../persistence/adjudicationOutput.js";
import { lookupPriorAdjudication } from "../persistence/adjudicationOutput.js";
import { adjudicatePair, type AdjudicationParseFn } from "./adjudicatePair.js";
import type { AdjudicationSpec } from "./adjudicationSpec.js";
import type { CandidatePair } from "./candidatePairs.js";

export function limitCandidates(candidates: CandidatePair[], limit?: number): CandidatePair[] {
  return limit === undefined ? candidates : candidates.slice(0, limit);
}

export interface AdjudicationProgressEvent {
  index: number;
  total: number;
  pairId: string;
  similarity: number;
  outcome: "success" | "failed" | "cached";
  relationship?: string;
  errorMessage?: string;
}

export interface RunAdjudicationParams {
  candidates: CandidatePair[];
  parseFn: AdjudicationParseFn;
  model: string;
  promptVersion: string;
  priorIndex: Map<string, AdjudicationResultItem>;
  /** Selects the prompt and relationship vocabulary; defaults to technical. */
  spec?: AdjudicationSpec;
  onProgress?: (event: AdjudicationProgressEvent) => void;
  retryOptions?: RetryOptions;
  sleep?: (ms: number) => Promise<void>;
}

function toSide(side: CandidatePair["a"]) {
  return {
    rootTs: side.rootTs,
    normalizedProblemStatement: side.normalizedProblemStatement,
    permalink: side.permalink,
  };
}

/**
 * Adjudicates each candidate in order. A cached prior success is reused
 * without calling the LLM again; a failure on one pair is recorded and
 * iteration continues, so one bad response never discards the work already
 * paid for in the same run.
 *
 * Every candidate goes through the model uniformly — there is deliberately no
 * "similarity >= X implies SAME" shortcut, so the adjudicator's behaviour can
 * be evaluated on its own merits across the whole candidate range.
 */
export async function runAdjudication(params: RunAdjudicationParams): Promise<AdjudicationResultItem[]> {
  const results: AdjudicationResultItem[] = [];
  const total = params.candidates.length;

  for (const [i, candidate] of params.candidates.entries()) {
    const index = i + 1;
    const cached = lookupPriorAdjudication(params.priorIndex, candidate.pairId, params.promptVersion, params.model);

    if (cached) {
      results.push(cached);
      params.onProgress?.({
        index,
        total,
        pairId: candidate.pairId,
        similarity: candidate.similarity,
        outcome: "cached",
        relationship: cached.relationship,
      });
      continue;
    }

    try {
      const adjudication = await adjudicatePair(
        params.parseFn,
        params.model,
        candidate,
        params.retryOptions,
        params.sleep,
        params.spec,
      );

      results.push({
        pairId: candidate.pairId,
        similarity: candidate.similarity,
        a: toSide(candidate.a),
        b: toSide(candidate.b),
        status: "success",
        relationship: adjudication.relationship,
        confidence: adjudication.confidence,
        reasoning: adjudication.reasoning,
        // Stored under one field for both tracks so grouping, naming, and
        // reporting need no per-category branching.
        proposedRecurringIssueName: adjudication.proposedName,
      });

      params.onProgress?.({
        index,
        total,
        pairId: candidate.pairId,
        similarity: candidate.similarity,
        outcome: "success",
        relationship: adjudication.relationship,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      results.push({
        pairId: candidate.pairId,
        similarity: candidate.similarity,
        a: toSide(candidate.a),
        b: toSide(candidate.b),
        status: "failed",
        error: errorMessage,
      });
      params.onProgress?.({
        index,
        total,
        pairId: candidate.pairId,
        similarity: candidate.similarity,
        outcome: "failed",
        errorMessage,
      });
    }
  }

  return results;
}
