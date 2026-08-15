import type { SimilarPair } from "../embeddings/nearestNeighbours.js";

/**
 * Review buckets are deliberately finer-grained than the observation buckets
 * in the similarity report: calibration needs resolution around the region
 * where "same issue" plausibly starts, which the report's 0.10-wide bands are
 * too coarse to show.
 *
 * None of these bounds is a threshold. They partition the evidence so a human
 * can label pairs across the range; the recurrence threshold is chosen later,
 * from those labels, not from this file.
 */
export const REVIEW_BUCKET_BOUNDS: ReadonlyArray<{ label: string; min: number; max: number }> = [
  { label: ">= 0.80", min: 0.8, max: Number.POSITIVE_INFINITY },
  { label: "0.75 – 0.7999", min: 0.75, max: 0.8 },
  { label: "0.70 – 0.7499", min: 0.7, max: 0.75 },
  { label: "0.65 – 0.6999", min: 0.65, max: 0.7 },
  { label: "0.60 – 0.6499", min: 0.6, max: 0.65 },
  { label: "below 0.60", min: Number.NEGATIVE_INFINITY, max: 0.6 },
];

/** Per-bucket sampling budget; buckets smaller than this are included whole. */
export const DEFAULT_MAX_PER_BUCKET = 12;

/**
 * The top bucket gets a larger allowance so every very-high-similarity pair
 * is reviewed whenever that is a manageable number, rather than sampled.
 */
export const DEFAULT_TOP_BUCKET_CAP = 50;

export function bucketLabelForSimilarity(similarity: number): string {
  const bound = REVIEW_BUCKET_BOUNDS.find((candidate) => similarity >= candidate.min && similarity < candidate.max);
  // The bounds partition the real line, so this is unreachable in practice.
  return bound?.label ?? REVIEW_BUCKET_BOUNDS[REVIEW_BUCKET_BOUNDS.length - 1]!.label;
}

/** Order-independent identity for an unordered pair. */
export function pairKey(pair: SimilarPair): string {
  return [pair.a.rootTs, pair.b.rootTs].sort().join("::");
}

/**
 * Total ordering used before sampling, so the selection cannot depend on the
 * order pairs happened to be generated in: similarity descending, then the
 * two rootTs values. Running twice over the same embeddings therefore yields
 * a byte-identical artifact.
 */
function compareForReview(left: SimilarPair, right: SimilarPair): number {
  if (left.similarity !== right.similarity) {
    return right.similarity - left.similarity;
  }
  return pairKey(left).localeCompare(pairKey(right));
}

/**
 * Evenly spaced sample across an already-ordered list, always including the
 * first and last element. Deterministic and spread across the bucket's whole
 * range rather than clustered at its top edge.
 */
export function strideSample<T>(items: T[], count: number): T[] {
  if (count <= 0) {
    return [];
  }
  if (items.length <= count) {
    return [...items];
  }
  if (count === 1) {
    return [items[0] as T];
  }

  const sampled: T[] = [];
  for (let i = 0; i < count; i++) {
    const index = Math.floor((i * (items.length - 1)) / (count - 1));
    sampled.push(items[index] as T);
  }
  return sampled;
}

export interface ReviewBucketSummary {
  label: string;
  available: number;
  selected: number;
}

export interface SelectReviewPairsOptions {
  maxPerBucket?: number;
  topBucketCap?: number;
}

export interface ReviewSelection {
  pairs: Array<SimilarPair & { bucket: string }>;
  buckets: ReviewBucketSummary[];
}

/**
 * Builds a representative, deterministic review set: every bucket contributes
 * up to its allowance, sampled evenly across that bucket's range. Duplicate
 * pairs are impossible by construction (unordered-pair keys are deduped),
 * which matters because the same two escalations must never be presented to a
 * reviewer twice.
 */
export function selectReviewPairs(
  allPairs: SimilarPair[],
  options: SelectReviewPairsOptions = {},
): ReviewSelection {
  const maxPerBucket = options.maxPerBucket ?? DEFAULT_MAX_PER_BUCKET;
  const topBucketCap = options.topBucketCap ?? DEFAULT_TOP_BUCKET_CAP;

  const seen = new Set<string>();
  const deduped: SimilarPair[] = [];
  for (const pair of [...allPairs].sort(compareForReview)) {
    const key = pairKey(pair);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(pair);
  }

  const selected: Array<SimilarPair & { bucket: string }> = [];
  const buckets: ReviewBucketSummary[] = [];

  for (const [index, bound] of REVIEW_BUCKET_BOUNDS.entries()) {
    const inBucket = deduped.filter((pair) => pair.similarity >= bound.min && pair.similarity < bound.max);
    const allowance = index === 0 ? topBucketCap : maxPerBucket;
    const sampled = strideSample(inBucket, allowance);

    buckets.push({ label: bound.label, available: inBucket.length, selected: sampled.length });
    selected.push(...sampled.map((pair) => ({ ...pair, bucket: bound.label })));
  }

  return { pairs: selected, buckets };
}
