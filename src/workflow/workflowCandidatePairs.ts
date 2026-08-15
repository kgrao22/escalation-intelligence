import { cosineSimilarity } from "../embeddings/cosineSimilarity.js";
import type { WorkflowEmbeddingEntry } from "../persistence/workflowEmbeddingOutput.js";
import type { WorkflowAdjudicationSide } from "../llm/prompts/workflowAdjudication.js";

/**
 * Candidate-generation floor, chosen from the measured 142-vector distribution
 * (median 0.3177, mean 0.3392). It is NOT a "same workflow" threshold — it only
 * decides which pairs are worth asking about. The LLM makes the actual call,
 * and pairs at 0.80 are routinely judged `different`.
 */
export const WORKFLOW_CANDIDATE_SIMILARITY_FLOOR = 0.8;

/** Local-only metadata. Never sent to the LLM. */
export interface WorkflowPairSideLocal extends WorkflowAdjudicationSide {
  rootTs: string;
  permalink: string | null;
}

export interface WorkflowCandidatePair {
  /** sorted(rootTsA, rootTsB) — stable across runs and input orderings. */
  pairId: string;
  similarity: number;
  a: WorkflowPairSideLocal;
  b: WorkflowPairSideLocal;
  /** Recorded for analysis; deliberately NOT used to filter. */
  sameClassification: boolean;
}

function toSide(entry: WorkflowEmbeddingEntry): WorkflowPairSideLocal {
  return {
    rootTs: entry.rootTs,
    permalink: entry.permalink,
    normalizedWorkflowStatement: entry.statement,
    workflowClassification: entry.workflowClassification,
    automationStatus: entry.automationStatus,
    nature: entry.nature,
  };
}

/** Canonical, order-independent identity for a pair of threads. */
export function workflowPairId(rootTsA: string, rootTsB: string): string {
  return [rootTsA, rootTsB].sort().join("::");
}

/**
 * Every pair at or above the floor, highest similarity first.
 *
 * Cross-classification pairs are deliberately RETAINED. Calibration showed
 * genuine same-workflow pairs crossing label boundaries (account_data_update ↔
 * policy_state_change for payment-state transitions, policy_reactivation ↔
 * policy_state_change), so filtering on classification would discard exactly
 * the pairs the adjudicator exists to catch.
 */
export function buildWorkflowCandidatePairs(
  entries: WorkflowEmbeddingEntry[],
  floor: number = WORKFLOW_CANDIDATE_SIMILARITY_FLOOR,
): WorkflowCandidatePair[] {
  const pairs: WorkflowCandidatePair[] = [];

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const first = entries[i] as WorkflowEmbeddingEntry;
      const second = entries[j] as WorkflowEmbeddingEntry;
      const similarity = cosineSimilarity(first.vector, second.vector);
      if (similarity < floor) {
        continue;
      }
      // Canonical side ordering so a pair renders identically every run.
      const [left, right] =
        first.rootTs.localeCompare(second.rootTs) <= 0 ? [first, second] : [second, first];
      pairs.push({
        pairId: workflowPairId(left.rootTs, right.rootTs),
        similarity,
        a: toSide(left),
        b: toSide(right),
        sameClassification:
          left.workflowClassification !== null &&
          left.workflowClassification === right.workflowClassification,
      });
    }
  }

  return pairs.sort((x, y) => y.similarity - x.similarity || x.pairId.localeCompare(y.pairId));
}

export interface SimilarityBand {
  /** Inclusive lower bound. */
  min?: number;
  /** Exclusive upper bound. */
  max?: number;
}

/**
 * Narrows candidates to a similarity band for calibration sampling.
 *
 * `min` is inclusive and `max` is exclusive, matching the reporting buckets so
 * a band named "0.80 – 0.8499" selects exactly the pairs that bucket counted.
 * Applied BEFORE any limit, so `--limit=20` inside a band means the top 20 of
 * that band rather than the top 20 overall.
 */
export function filterBySimilarityBand(
  pairs: WorkflowCandidatePair[],
  band: SimilarityBand,
): WorkflowCandidatePair[] {
  return pairs.filter(
    (pair) =>
      (band.min === undefined || pair.similarity >= band.min) &&
      (band.max === undefined || pair.similarity < band.max),
  );
}

export function limitWorkflowCandidates(
  pairs: WorkflowCandidatePair[],
  limit?: number,
): WorkflowCandidatePair[] {
  return limit === undefined ? pairs : pairs.slice(0, limit);
}

/**
 * The EXACT payload that may cross the network. Constructed by explicit field
 * projection rather than by deleting keys, so a field added to the local side
 * can never leak by omission.
 */
export function toAdjudicationPayload(side: WorkflowPairSideLocal): WorkflowAdjudicationSide {
  return {
    normalizedWorkflowStatement: side.normalizedWorkflowStatement,
    workflowClassification: side.workflowClassification,
    automationStatus: side.automationStatus,
    nature: side.nature,
  };
}

export interface CandidateDistributionBucket {
  label: string;
  count: number;
}

export function describeWorkflowCandidateDistribution(
  pairs: WorkflowCandidatePair[],
): CandidateDistributionBucket[] {
  const bounds: Array<{ label: string; min: number; max: number }> = [
    { label: ">= 0.95", min: 0.95, max: Number.POSITIVE_INFINITY },
    { label: "0.90 – 0.9499", min: 0.9, max: 0.95 },
    { label: "0.85 – 0.8999", min: 0.85, max: 0.9 },
    { label: "0.80 – 0.8499", min: 0.8, max: 0.85 },
  ];
  return bounds.map((bound) => ({
    label: bound.label,
    count: pairs.filter((pair) => pair.similarity >= bound.min && pair.similarity < bound.max).length,
  }));
}
