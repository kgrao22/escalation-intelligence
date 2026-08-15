import type { SimilarPair } from "../embeddings/nearestNeighbours.js";
import type { AdjudicationSide } from "../llm/prompts/recurrenceAdjudication.js";
import type { EscalationAnalysis } from "../llm/schemas/escalationAnalysis.js";
import type { ExtractionOutput } from "../persistence/extractionOutput.js";
import { pairKey } from "../review/selectReviewPairs.js";

export interface CandidatePairSide extends AdjudicationSide {
  rootTs: string;
  permalink: string | null;
  /** Populated for the workflow track; ignored by the technical prompt. */
  workflowClassification?: string | null;
  automationStatus?: string | null;
}

export interface CandidatePair {
  pairId: string;
  similarity: number;
  a: CandidatePairSide;
  b: CandidatePairSide;
}

/**
 * Index of successful technical extractions by rootTs, used to enrich each
 * embedding-derived pair with root cause and resolution evidence that the
 * embeddings file does not carry.
 */
export function buildExtractionIndex(extraction: ExtractionOutput): Map<string, EscalationAnalysis> {
  const index = new Map<string, EscalationAnalysis>();
  for (const result of extraction.results) {
    if (result.status !== "success" || !result.analysis) {
      continue;
    }
    index.set(result.rootTs, result.analysis);
  }
  return index;
}

/**
 * Applies the candidate-generation floor.
 *
 * This decides only which pairs are worth an LLM call — it is not a
 * recurrence decision. Pairs below the floor are never sent to Claude, which
 * is where nearly all of the cost saving comes from (2,415 pairs down to
 * ~58 at 0.60).
 */
export function filterCandidatesByFloor(pairs: SimilarPair[], floor: number): SimilarPair[] {
  return pairs.filter((pair) => pair.similarity >= floor);
}

function toSide(
  side: SimilarPair["a"],
  analysis: EscalationAnalysis | undefined,
): CandidatePairSide {
  return {
    rootTs: side.rootTs,
    permalink: side.permalink,
    normalizedProblemStatement: side.normalizedProblemStatement,
    classification: analysis?.classification ?? null,
    affectedSystem: analysis?.affectedSystem ?? null,
    issueTypeHint: analysis?.issueTypeHint ?? null,
    suspectedRootCause: analysis?.suspectedRootCause ?? null,
    rootCauseConfidence: analysis?.rootCauseConfidence ?? null,
    resolutionStatus: analysis?.resolutionStatus ?? null,
    resolutionSummary: analysis?.resolutionSummary ?? null,
    workflowClassification: analysis?.workflowClassification ?? null,
    automationStatus: analysis?.automationStatus ?? null,
  };
}

/**
 * Joins each above-floor pair back to its extraction record by rootTs. A
 * missing extraction is not fatal — the pair is still adjudicated on its
 * normalized statements alone, with the absent fields reported to the model
 * as "not established" rather than silently omitted.
 */
export function buildCandidatePairs(
  pairs: SimilarPair[],
  floor: number,
  extractionIndex: Map<string, EscalationAnalysis>,
): CandidatePair[] {
  return filterCandidatesByFloor(pairs, floor).map((pair) => ({
    pairId: pairKey(pair),
    similarity: pair.similarity,
    a: toSide(pair.a, extractionIndex.get(pair.a.rootTs)),
    b: toSide(pair.b, extractionIndex.get(pair.b.rootTs)),
  }));
}

export interface CandidateDistributionBucket {
  label: string;
  min: number;
  max: number;
  count: number;
}

const CANDIDATE_DISTRIBUTION_BOUNDS: ReadonlyArray<{ label: string; min: number; max: number }> = [
  { label: ">= 0.80", min: 0.8, max: Number.POSITIVE_INFINITY },
  { label: "0.75 – 0.7999", min: 0.75, max: 0.8 },
  { label: "0.70 – 0.7499", min: 0.7, max: 0.75 },
  { label: "0.65 – 0.6999", min: 0.65, max: 0.7 },
  { label: "0.60 – 0.6499", min: 0.6, max: 0.65 },
];

/** Similarity spread among the selected candidates, for the dry-run preview. */
export function describeCandidateDistribution(candidates: CandidatePair[]): CandidateDistributionBucket[] {
  return CANDIDATE_DISTRIBUTION_BOUNDS.map((bound) => ({
    label: bound.label,
    min: bound.min,
    max: bound.max,
    count: candidates.filter((c) => c.similarity >= bound.min && c.similarity < bound.max).length,
  }));
}
