import { DEFAULT_RETRY_OPTIONS, withRetry, type RetryOptions } from "../llm/retry.js";
import type { StructuredParseFn } from "../llm/structuredParse.js";
import type { AdjudicationSpec, NormalizedAdjudication } from "./adjudicationSpec.js";
import { adjudicationSpecFor } from "./adjudicationSpec.js";
import type { CandidatePair } from "./candidatePairs.js";

/**
 * Parsing is deliberately untyped at this boundary: the two tracks return
 * different shapes, and the spec's `normalize` is what turns either into the
 * common form.
 */
export type AdjudicationParseFn = StructuredParseFn<unknown>;

export class AdjudicationRefusedError extends Error {
  constructor(pairId: string) {
    super(`LLM declined to adjudicate pair ${pairId} (stop_reason: refusal)`);
    this.name = "AdjudicationRefusedError";
  }
}

export class AdjudicationParseError extends Error {
  constructor(pairId: string, stopReason: string | null) {
    super(
      `LLM response for pair ${pairId} did not match the expected schema (stop_reason: ${stopReason ?? "unknown"})`,
    );
    this.name = "AdjudicationParseError";
  }
}

export interface AdjudicatedPair extends NormalizedAdjudication {
  pairId: string;
  similarity: number;
}

export async function adjudicatePair(
  parseFn: AdjudicationParseFn,
  model: string,
  candidate: CandidatePair,
  retryOptions: RetryOptions = DEFAULT_RETRY_OPTIONS,
  sleep?: (ms: number) => Promise<void>,
  spec: AdjudicationSpec = adjudicationSpecFor("technical"),
): Promise<AdjudicatedPair> {
  const userPrompt = spec.buildUserPrompt(candidate.a, candidate.b);

  const response = await withRetry(
    () => parseFn({ model, systemPrompt: spec.systemPrompt, userPrompt }),
    retryOptions,
    sleep,
  );

  if (response.stop_reason === "refusal") {
    throw new AdjudicationRefusedError(candidate.pairId);
  }
  if (!response.parsed_output) {
    throw new AdjudicationParseError(candidate.pairId, response.stop_reason);
  }

  let normalized: NormalizedAdjudication;
  try {
    normalized = spec.normalize(response.parsed_output);
  } catch {
    // A response that parsed as JSON but not as this track's schema is as
    // unusable as no response at all.
    throw new AdjudicationParseError(candidate.pairId, response.stop_reason);
  }

  return { ...normalized, pairId: candidate.pairId, similarity: candidate.similarity };
}
