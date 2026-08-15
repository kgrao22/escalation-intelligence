import { describe, expect, it } from "vitest";
import {
  computeSimilarityBuckets,
  computeSimilarityStats,
  expectedUniquePairCount,
  mean,
  median,
  SIMILARITY_BUCKET_BOUNDS,
} from "../../src/embeddings/similarityStats.js";

describe("median", () => {
  it("returns the middle value for an odd count", () => {
    expect(median([0.1, 0.5, 0.9])).toBe(0.5);
  });

  it("averages the two middle values for an even count", () => {
    expect(median([0.2, 0.4, 0.6, 0.8])).toBeCloseTo(0.5, 10);
  });

  it("is order-independent", () => {
    expect(median([0.9, 0.1, 0.5])).toBe(median([0.1, 0.5, 0.9]));
  });

  it("returns 0 for an empty list", () => {
    expect(median([])).toBe(0);
  });
});

describe("mean", () => {
  it("averages the values", () => {
    expect(mean([0.2, 0.4, 0.6])).toBeCloseTo(0.4, 10);
  });

  it("returns 0 for an empty list", () => {
    expect(mean([])).toBe(0);
  });
});

describe("expectedUniquePairCount", () => {
  it("computes n*(n-1)/2", () => {
    expect(expectedUniquePairCount(18)).toBe(153);
    expect(expectedUniquePairCount(54)).toBe(1431);
  });

  it("returns 0 for fewer than two items", () => {
    expect(expectedUniquePairCount(1)).toBe(0);
    expect(expectedUniquePairCount(0)).toBe(0);
  });
});

describe("computeSimilarityBuckets", () => {
  it("uses the six specified observation buckets in descending order", () => {
    expect(SIMILARITY_BUCKET_BOUNDS.map((b) => b.label)).toEqual([
      "0.80 – 1.00",
      "0.70 – 0.7999",
      "0.60 – 0.6999",
      "0.50 – 0.5999",
      "0.40 – 0.4999",
      "below 0.40",
    ]);
  });

  it("counts values into the correct buckets", () => {
    const buckets = computeSimilarityBuckets([0.95, 0.88, 0.75, 0.65, 0.55, 0.45, 0.3, -0.1]);
    const counts = Object.fromEntries(buckets.map((b) => [b.label, b.count]));

    expect(counts["0.80 – 1.00"]).toBe(2);
    expect(counts["0.70 – 0.7999"]).toBe(1);
    expect(counts["0.60 – 0.6999"]).toBe(1);
    expect(counts["0.50 – 0.5999"]).toBe(1);
    expect(counts["0.40 – 0.4999"]).toBe(1);
    expect(counts["below 0.40"]).toBe(2);
  });

  it("places boundary values in the higher bucket (lower bound inclusive)", () => {
    const counts = Object.fromEntries(
      computeSimilarityBuckets([0.8, 0.7, 0.6, 0.5, 0.4]).map((b) => [b.label, b.count]),
    );
    expect(counts["0.80 – 1.00"]).toBe(1);
    expect(counts["0.70 – 0.7999"]).toBe(1);
    expect(counts["0.60 – 0.6999"]).toBe(1);
    expect(counts["0.50 – 0.5999"]).toBe(1);
    expect(counts["0.40 – 0.4999"]).toBe(1);
    expect(counts["below 0.40"]).toBe(0);
  });

  it("includes a perfect 1.0 similarity in the top bucket", () => {
    const counts = Object.fromEntries(computeSimilarityBuckets([1]).map((b) => [b.label, b.count]));
    expect(counts["0.80 – 1.00"]).toBe(1);
  });

  it("partitions every value exactly once", () => {
    const values = [1, 0.85, 0.8, 0.79, 0.7, 0.6, 0.5, 0.4, 0.39, 0, -0.5];
    const total = computeSimilarityBuckets(values).reduce((sum, b) => sum + b.count, 0);
    expect(total).toBe(values.length);
  });

  it("returns all-zero counts for no values", () => {
    expect(computeSimilarityBuckets([]).every((b) => b.count === 0)).toBe(true);
  });
});

describe("computeSimilarityStats", () => {
  it("reports item count, pair count, max, median, and mean", () => {
    const stats = computeSimilarityStats(3, [0.9, 0.5, 0.1]);
    expect(stats.totalItems).toBe(3);
    expect(stats.totalPairs).toBe(3);
    expect(stats.max).toBeCloseTo(0.9, 10);
    expect(stats.median).toBeCloseTo(0.5, 10);
    expect(stats.mean).toBeCloseTo(0.5, 10);
  });

  it("handles an empty similarity list without producing NaN", () => {
    const stats = computeSimilarityStats(1, []);
    expect(stats).toEqual({ totalItems: 1, totalPairs: 0, max: 0, median: 0, mean: 0 });
    expect(Number.isNaN(stats.mean)).toBe(false);
  });
});
