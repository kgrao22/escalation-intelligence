/**
 * Voyage accepts up to 1000 inputs per request. 128 stays far inside that
 * and inside the per-request token limit while keeping the whole current
 * dataset (a few dozen short statements) in a single call.
 */
export const DEFAULT_EMBEDDING_BATCH_SIZE = 128;

export function chunk<T>(items: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`Invalid batch size: ${size}. Must be a positive integer.`);
  }

  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

export function countBatches(itemCount: number, size: number = DEFAULT_EMBEDDING_BATCH_SIZE): number {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`Invalid batch size: ${size}. Must be a positive integer.`);
  }
  return Math.ceil(itemCount / size);
}
