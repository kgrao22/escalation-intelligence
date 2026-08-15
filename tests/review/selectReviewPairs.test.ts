import { describe, expect, it } from "vitest";
import type { SimilarPair } from "../../src/embeddings/nearestNeighbours.js";
import {
  bucketLabelForSimilarity,
  DEFAULT_MAX_PER_BUCKET,
  pairKey,
  REVIEW_BUCKET_BOUNDS,
  selectReviewPairs,
  strideSample,
} from "../../src/review/selectReviewPairs.js";

function pair(aTs: string, bTs: string, similarity: number): SimilarPair {
  return {
    similarity,
    a: { rootTs: aTs, normalizedProblemStatement: `statement ${aTs}`, permalink: `https://slack/${aTs}` },
    b: { rootTs: bTs, normalizedProblemStatement: `statement ${bTs}`, permalink: `https://slack/${bTs}` },
  };
}

/** n distinct pairs spread evenly across [min, max). */
function pairsInRange(count: number, min: number, max: number, idOffset = 0): SimilarPair[] {
  return Array.from({ length: count }, (_, i) =>
    pair(`${idOffset + i}a`, `${idOffset + i}b`, min + ((max - min) * i) / Math.max(count, 1)),
  );
}

describe("REVIEW_BUCKET_BOUNDS", () => {
  it("uses the six requested calibration bands", () => {
    expect(REVIEW_BUCKET_BOUNDS.map((b) => b.label)).toEqual([
      ">= 0.80",
      "0.75 – 0.7999",
      "0.70 – 0.7499",
      "0.65 – 0.6999",
      "0.60 – 0.6499",
      "below 0.60",
    ]);
  });

  it("is finer-grained than the report buckets around the interesting range", () => {
    // 0.75 and 0.65 are boundaries here but not in the report's 0.10-wide bands.
    expect(REVIEW_BUCKET_BOUNDS.some((b) => b.min === 0.75)).toBe(true);
    expect(REVIEW_BUCKET_BOUNDS.some((b) => b.min === 0.65)).toBe(true);
  });
});

describe("bucketLabelForSimilarity — boundaries", () => {
  it("places values in the bucket whose lower bound they meet", () => {
    expect(bucketLabelForSimilarity(0.8)).toBe(">= 0.80");
    expect(bucketLabelForSimilarity(0.75)).toBe("0.75 – 0.7999");
    expect(bucketLabelForSimilarity(0.7)).toBe("0.70 – 0.7499");
    expect(bucketLabelForSimilarity(0.65)).toBe("0.65 – 0.6999");
    expect(bucketLabelForSimilarity(0.6)).toBe("0.60 – 0.6499");
  });

  it("puts values just below a boundary in the lower bucket", () => {
    expect(bucketLabelForSimilarity(0.7999)).toBe("0.75 – 0.7999");
    expect(bucketLabelForSimilarity(0.7499)).toBe("0.70 – 0.7499");
    expect(bucketLabelForSimilarity(0.6999)).toBe("0.65 – 0.6999");
    expect(bucketLabelForSimilarity(0.6499)).toBe("0.60 – 0.6499");
    expect(bucketLabelForSimilarity(0.5999)).toBe("below 0.60");
  });

  it("handles the extremes, including a perfect score and negatives", () => {
    expect(bucketLabelForSimilarity(1)).toBe(">= 0.80");
    expect(bucketLabelForSimilarity(0)).toBe("below 0.60");
    expect(bucketLabelForSimilarity(-0.034)).toBe("below 0.60");
  });
});

describe("strideSample", () => {
  it("returns everything when the list is no larger than the budget", () => {
    expect(strideSample([1, 2, 3], 5)).toEqual([1, 2, 3]);
    expect(strideSample([1, 2, 3], 3)).toEqual([1, 2, 3]);
  });

  it("includes the first and last element when sampling", () => {
    const sample = strideSample([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4);
    expect(sample[0]).toBe(0);
    expect(sample.at(-1)).toBe(9);
  });

  it("returns exactly the requested count with no duplicates", () => {
    const items = Array.from({ length: 32 }, (_, i) => i);
    const sample = strideSample(items, 12);
    expect(sample).toHaveLength(12);
    expect(new Set(sample).size).toBe(12);
  });

  it("spreads across the range rather than taking a prefix", () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const sample = strideSample(items, 5) as number[];
    expect(sample).toEqual([0, 24, 49, 74, 99]);
  });

  it("is deterministic across repeated calls", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    expect(strideSample(items, 7)).toEqual(strideSample(items, 7));
  });

  it("handles degenerate budgets", () => {
    expect(strideSample([1, 2, 3], 0)).toEqual([]);
    expect(strideSample([1, 2, 3], 1)).toEqual([1]);
  });
});

describe("selectReviewPairs — bucket allocation", () => {
  it("reports available and selected counts per bucket", () => {
    const pairs = [
      ...pairsInRange(3, 0.8, 0.9, 0),
      ...pairsInRange(2, 0.75, 0.8, 100),
      ...pairsInRange(40, 0.0, 0.6, 200),
    ];

    const { buckets } = selectReviewPairs(pairs);
    const byLabel = Object.fromEntries(buckets.map((b) => [b.label, b]));

    expect(byLabel[">= 0.80"]).toMatchObject({ available: 3, selected: 3 });
    expect(byLabel["0.75 – 0.7999"]).toMatchObject({ available: 2, selected: 2 });
    expect(byLabel["below 0.60"]).toMatchObject({ available: 40, selected: DEFAULT_MAX_PER_BUCKET });
  });

  it("includes every bucket in the summary even when empty", () => {
    const { buckets } = selectReviewPairs([pair("1a", "1b", 0.9)]);
    expect(buckets).toHaveLength(REVIEW_BUCKET_BOUNDS.length);
    expect(buckets.find((b) => b.label === "below 0.60")).toMatchObject({ available: 0, selected: 0 });
  });

  it("includes all very-high-similarity pairs when the count is manageable", () => {
    const { buckets } = selectReviewPairs(pairsInRange(30, 0.8, 0.99));
    expect(buckets[0]).toMatchObject({ available: 30, selected: 30 });
  });

  it("caps the top bucket only when it is unmanageably large", () => {
    const { buckets } = selectReviewPairs(pairsInRange(120, 0.8, 0.99), { topBucketCap: 50 });
    expect(buckets[0]).toMatchObject({ available: 120, selected: 50 });
  });

  it("respects a custom per-bucket budget", () => {
    const { buckets } = selectReviewPairs(pairsInRange(40, 0.0, 0.6), { maxPerBucket: 5 });
    expect(buckets.find((b) => b.label === "below 0.60")?.selected).toBe(5);
  });

  it("tags each selected pair with its bucket", () => {
    const { pairs } = selectReviewPairs([pair("1a", "1b", 0.85), pair("2a", "2b", 0.62)]);
    expect(pairs.find((p) => p.similarity === 0.85)?.bucket).toBe(">= 0.80");
    expect(pairs.find((p) => p.similarity === 0.62)?.bucket).toBe("0.60 – 0.6499");
  });

  it("orders selected pairs by bucket, highest similarity band first", () => {
    const { pairs } = selectReviewPairs([pair("2a", "2b", 0.3), pair("1a", "1b", 0.9), pair("3a", "3b", 0.72)]);
    expect(pairs.map((p) => p.bucket)).toEqual([">= 0.80", "0.70 – 0.7499", "below 0.60"]);
  });
});

describe("selectReviewPairs — determinism", () => {
  it("produces an identical selection across repeated runs", () => {
    const pairs = pairsInRange(60, 0.0, 0.9);
    expect(selectReviewPairs(pairs)).toEqual(selectReviewPairs(pairs));
  });

  it("is independent of the input ordering", () => {
    const pairs = pairsInRange(60, 0.0, 0.9);
    const forward = selectReviewPairs(pairs);
    const reversed = selectReviewPairs([...pairs].reverse());
    expect(reversed.pairs.map(pairKey)).toEqual(forward.pairs.map(pairKey));
  });

  it("breaks similarity ties deterministically", () => {
    const tied = [pair("zz", "yy", 0.7), pair("aa", "bb", 0.7), pair("mm", "nn", 0.7)];
    const first = selectReviewPairs(tied, { maxPerBucket: 2 });
    const second = selectReviewPairs([...tied].reverse(), { maxPerBucket: 2 });
    expect(first.pairs.map(pairKey)).toEqual(second.pairs.map(pairKey));
  });
});

describe("selectReviewPairs — duplicate prevention", () => {
  it("never presents the same unordered pair twice", () => {
    const duplicated = [pair("A", "B", 0.9), pair("B", "A", 0.9), pair("A", "B", 0.9)];
    const { pairs } = selectReviewPairs(duplicated);
    expect(pairs).toHaveLength(1);
  });

  it("counts a deduplicated pair once in the bucket summary", () => {
    const { buckets } = selectReviewPairs([pair("A", "B", 0.9), pair("B", "A", 0.9)]);
    expect(buckets[0]).toMatchObject({ available: 1, selected: 1 });
  });

  it("keeps distinct pairs that merely share one side", () => {
    const { pairs } = selectReviewPairs([pair("A", "B", 0.9), pair("A", "C", 0.9)]);
    expect(pairs).toHaveLength(2);
  });

  it("yields unique pairIds across the whole selection", () => {
    const { pairs } = selectReviewPairs(pairsInRange(60, 0.0, 0.9));
    const keys = pairs.map(pairKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("pairKey", () => {
  it("is order-independent", () => {
    expect(pairKey(pair("A", "B", 0.5))).toBe(pairKey(pair("B", "A", 0.5)));
  });
});
