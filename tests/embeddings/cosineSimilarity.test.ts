import { describe, expect, it } from "vitest";
import {
  assertConsistentDimension,
  cosineSimilarity,
  VectorShapeError,
} from "../../src/embeddings/cosineSimilarity.js";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it("returns 1 for parallel vectors of different magnitude", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it("is symmetric", () => {
    const a = [0.2, -0.5, 0.9];
    const b = [0.7, 0.1, -0.3];
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 10);
  });

  it("returns 0 (never NaN) when one vector is all zeroes", () => {
    const result = cosineSimilarity([0, 0, 0], [1, 2, 3]);
    expect(result).toBe(0);
    expect(Number.isNaN(result)).toBe(false);
  });

  it("returns 0 (never NaN) when both vectors are all zeroes", () => {
    const result = cosineSimilarity([0, 0], [0, 0]);
    expect(result).toBe(0);
    expect(Number.isNaN(result)).toBe(false);
  });

  it("throws on dimension mismatch", () => {
    expect(() => cosineSimilarity([1, 2, 3], [1, 2])).toThrow(VectorShapeError);
    expect(() => cosineSimilarity([1, 2, 3], [1, 2])).toThrow(/dimension mismatch/i);
  });

  it("throws on an empty vector", () => {
    expect(() => cosineSimilarity([], [])).toThrow(VectorShapeError);
    expect(() => cosineSimilarity([], [1])).toThrow(VectorShapeError);
  });
});

describe("assertConsistentDimension", () => {
  it("returns the shared dimension", () => {
    expect(assertConsistentDimension([[1, 2, 3], [4, 5, 6]])).toBe(3);
  });

  it("throws when vectors have differing dimensions", () => {
    expect(() => assertConsistentDimension([[1, 2, 3], [4, 5]])).toThrow(/Inconsistent embedding dimensions/);
  });

  it("throws when there are no vectors", () => {
    expect(() => assertConsistentDimension([])).toThrow(VectorShapeError);
  });

  it("throws when vectors are empty", () => {
    expect(() => assertConsistentDimension([[]])).toThrow(/non-empty/);
  });
});
