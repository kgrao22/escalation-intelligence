export class VectorShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VectorShapeError";
  }
}

/**
 * Cosine similarity between two equal-length vectors.
 *
 * A zero-length vector has no direction, so similarity against it is
 * undefined. Rather than returning NaN (which silently poisons sorting and
 * comparisons downstream), this returns 0 — "no measurable similarity".
 * Mismatched or empty vectors are programming errors, not data conditions,
 * so those throw instead.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) {
    throw new VectorShapeError("Cannot compute cosine similarity on an empty vector.");
  }
  if (a.length !== b.length) {
    throw new VectorShapeError(
      `Vector dimension mismatch: ${a.length} vs ${b.length}. Embeddings must come from the same model.`,
    );
  }

  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < a.length; i++) {
    const valueA = a[i] as number;
    const valueB = b[i] as number;
    dotProduct += valueA * valueB;
    magnitudeA += valueA * valueA;
    magnitudeB += valueB * valueB;
  }

  const denominator = Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB);
  if (denominator === 0) {
    return 0;
  }

  return dotProduct / denominator;
}

/**
 * Confirms every vector shares one dimension and returns it. Guards against
 * mixing embeddings produced by different models or output_dimension values.
 */
export function assertConsistentDimension(vectors: number[][]): number {
  if (vectors.length === 0) {
    throw new VectorShapeError("Expected at least one embedding vector.");
  }

  const dimension = (vectors[0] as number[]).length;
  if (dimension === 0) {
    throw new VectorShapeError("Embedding vectors must be non-empty.");
  }

  for (const [index, vector] of vectors.entries()) {
    if (vector.length !== dimension) {
      throw new VectorShapeError(
        `Inconsistent embedding dimensions: vector ${index} has ${vector.length}, expected ${dimension}.`,
      );
    }
  }

  return dimension;
}
