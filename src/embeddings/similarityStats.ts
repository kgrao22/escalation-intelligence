export interface SimilarityStats {
  totalItems: number;
  totalPairs: number;
  max: number;
  median: number;
  mean: number;
}

export interface SimilarityBucket {
  label: string;
  /** Inclusive lower bound. */
  min: number;
  /** Exclusive upper bound, except the top bucket which includes 1.0. */
  max: number;
  count: number;
}

/**
 * Observation buckets only.
 *
 * These describe how similarity is distributed across the dataset so a human
 * can see the shape of it. No bucket means "same issue", and nothing here
 * selects a clustering threshold — that decision is deliberately left out of
 * the code at this stage.
 */
export const SIMILARITY_BUCKET_BOUNDS: ReadonlyArray<{ label: string; min: number; max: number }> = [
  { label: "0.80 – 1.00", min: 0.8, max: Number.POSITIVE_INFINITY },
  { label: "0.70 – 0.7999", min: 0.7, max: 0.8 },
  { label: "0.60 – 0.6999", min: 0.6, max: 0.7 },
  { label: "0.50 – 0.5999", min: 0.5, max: 0.6 },
  { label: "0.40 – 0.4999", min: 0.4, max: 0.5 },
  { label: "below 0.40", min: Number.NEGATIVE_INFINITY, max: 0.4 },
];

export function computeSimilarityBuckets(similarities: number[]): SimilarityBucket[] {
  return SIMILARITY_BUCKET_BOUNDS.map((bound) => ({
    label: bound.label,
    min: bound.min,
    max: bound.max,
    count: similarities.filter((value) => value >= bound.min && value < bound.max).length,
  }));
}

export function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2)
    : (sorted[middle] as number);
}

export function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function computeSimilarityStats(itemCount: number, similarities: number[]): SimilarityStats {
  return {
    totalItems: itemCount,
    totalPairs: similarities.length,
    max: similarities.length === 0 ? 0 : Math.max(...similarities),
    median: median(similarities),
    mean: mean(similarities),
  };
}

/** n items yield n*(n-1)/2 unique unordered pairs. */
export function expectedUniquePairCount(itemCount: number): number {
  return itemCount < 2 ? 0 : (itemCount * (itemCount - 1)) / 2;
}
