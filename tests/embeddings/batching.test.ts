import { describe, expect, it } from "vitest";
import { chunk, countBatches, DEFAULT_EMBEDDING_BATCH_SIZE } from "../../src/embeddings/batching.js";

describe("chunk", () => {
  it("splits items into batches of the given size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns a single batch when everything fits", () => {
    expect(chunk([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
  });

  it("returns an empty array for no items", () => {
    expect(chunk([], 10)).toEqual([]);
  });

  it("preserves order across batches", () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    expect(chunk(items, 3).flat()).toEqual(items);
  });

  it("throws on an invalid batch size", () => {
    expect(() => chunk([1], 0)).toThrow(/Invalid batch size/);
    expect(() => chunk([1], -1)).toThrow(/Invalid batch size/);
  });
});

describe("countBatches", () => {
  it("counts batches needed for the current dataset size", () => {
    // 18 technical escalations fit in one default-sized batch.
    expect(countBatches(18, DEFAULT_EMBEDDING_BATCH_SIZE)).toBe(1);
  });

  it("rounds up for partial batches", () => {
    expect(countBatches(5, 2)).toBe(3);
    expect(countBatches(4, 2)).toBe(2);
  });

  it("returns 0 for no items", () => {
    expect(countBatches(0, 10)).toBe(0);
  });

  it("keeps the default batch size within Voyage's 1000-input limit", () => {
    expect(DEFAULT_EMBEDDING_BATCH_SIZE).toBeLessThanOrEqual(1000);
  });
});
