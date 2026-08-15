import { cosineSimilarity } from "../embeddings/cosineSimilarity.js";
import { mean, median } from "../embeddings/similarityStats.js";
import type { WorkflowEmbeddingEntry } from "../persistence/workflowEmbeddingOutput.js";

/**
 * Finer-grained than the technical buckets on purpose. Workflow statements are
 * far more formulaic than defect descriptions, so the interesting variation is
 * expected to sit high in the range where the technical buckets collapse
 * everything into one "0.80 – 1.00" bin.
 *
 * These are OBSERVATION buckets. No bucket means "same workflow", and nothing
 * here selects a candidate floor — that decision waits for this evidence.
 */
export const WORKFLOW_SIMILARITY_BUCKET_BOUNDS: ReadonlyArray<{ label: string; min: number; max: number }> = [
  { label: ">= 0.90", min: 0.9, max: Number.POSITIVE_INFINITY },
  { label: "0.85 – 0.8999", min: 0.85, max: 0.9 },
  { label: "0.80 – 0.8499", min: 0.8, max: 0.85 },
  { label: "0.75 – 0.7999", min: 0.75, max: 0.8 },
  { label: "0.70 – 0.7499", min: 0.7, max: 0.75 },
  { label: "0.65 – 0.6999", min: 0.65, max: 0.7 },
  { label: "0.60 – 0.6499", min: 0.6, max: 0.65 },
  { label: "< 0.60", min: Number.NEGATIVE_INFINITY, max: 0.6 },
];

export interface WorkflowSimilarityBucket {
  label: string;
  min: number;
  max: number;
  count: number;
}

export function computeWorkflowBuckets(similarities: number[]): WorkflowSimilarityBucket[] {
  return WORKFLOW_SIMILARITY_BUCKET_BOUNDS.map((bound) => ({
    label: bound.label,
    min: bound.min,
    max: bound.max,
    count: similarities.filter((value) => value >= bound.min && value < bound.max).length,
  }));
}

export interface WorkflowPairSide {
  rootTs: string;
  permalink: string | null;
  statement: string;
  workflowClassification: string | null;
  automationStatus: string;
  nature: WorkflowEmbeddingEntry["nature"];
}

export interface WorkflowPair {
  similarity: number;
  a: WorkflowPairSide;
  b: WorkflowPairSide;
  /** True when both sides carry the same non-null workflowClassification. */
  sameClassification: boolean;
}

function toSide(entry: WorkflowEmbeddingEntry): WorkflowPairSide {
  return {
    rootTs: entry.rootTs,
    permalink: entry.permalink,
    statement: entry.statement,
    workflowClassification: entry.workflowClassification,
    automationStatus: entry.automationStatus,
    nature: entry.nature,
  };
}

/**
 * Every unique unordered pair, highest similarity first.
 *
 * Each pair is canonicalised so the lower rootTs is always side A. Without
 * that, a pair's identity would depend on the order entries happen to sit in
 * the file — the same two threads would render as "A,B" or "B,A" — and the
 * top-30 list would shuffle between runs. Ties then break on rootTs, so the
 * whole ordering is reproducible across runs and machines.
 */
export function computeWorkflowPairs(entries: WorkflowEmbeddingEntry[]): WorkflowPair[] {
  const pairs: WorkflowPair[] = [];

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const first = entries[i] as WorkflowEmbeddingEntry;
      const second = entries[j] as WorkflowEmbeddingEntry;
      const [left, right] = first.rootTs.localeCompare(second.rootTs) <= 0 ? [first, second] : [second, first];
      pairs.push({
        similarity: cosineSimilarity(left.vector, right.vector),
        a: toSide(left),
        b: toSide(right),
        sameClassification:
          left.workflowClassification !== null &&
          left.workflowClassification === right.workflowClassification,
      });
    }
  }

  return pairs.sort(
    (x, y) =>
      y.similarity - x.similarity ||
      x.a.rootTs.localeCompare(y.a.rootTs) ||
      x.b.rootTs.localeCompare(y.b.rootTs),
  );
}

export interface WorkflowSimilaritySummary {
  totalEmbeddings: number;
  totalPairs: number;
  max: number;
  median: number;
  mean: number;
}

export function summarizeWorkflowSimilarity(
  entryCount: number,
  similarities: number[],
): WorkflowSimilaritySummary {
  return {
    totalEmbeddings: entryCount,
    totalPairs: similarities.length,
    max: similarities.length === 0 ? 0 : Math.max(...similarities),
    median: median(similarities),
    mean: mean(similarities),
  };
}

export interface ClassificationSplit {
  same: WorkflowSimilaritySummary & { buckets: WorkflowSimilarityBucket[] };
  cross: WorkflowSimilaritySummary & { buckets: WorkflowSimilarityBucket[] };
}

/**
 * Splits the distribution by whether a pair shares a workflowClassification.
 * Reported side by side so a later decision about whether classification should
 * constrain candidate generation rests on measured separation, not intuition.
 * No pair is filtered out here.
 */
export function splitByClassification(pairs: WorkflowPair[]): ClassificationSplit {
  const same = pairs.filter((pair) => pair.sameClassification).map((pair) => pair.similarity);
  const cross = pairs.filter((pair) => !pair.sameClassification).map((pair) => pair.similarity);

  return {
    same: { ...summarizeWorkflowSimilarity(0, same), buckets: computeWorkflowBuckets(same) },
    cross: { ...summarizeWorkflowSimilarity(0, cross), buckets: computeWorkflowBuckets(cross) },
  };
}
