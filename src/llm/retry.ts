import Anthropic from "@anthropic-ai/sdk";

export interface RetryOptions {
  /** Total attempts including the first — bounded, never infinite. */
  maxAttempts: number;
  baseDelayMs: number;
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = { maxAttempts: 3, baseDelayMs: 1000 };

/**
 * Only rate limits, transient server errors, and network failures are worth
 * retrying — a bad request or a schema/content problem will fail identically
 * on every attempt.
 */
export function isRetryableAnthropicError(err: unknown): boolean {
  return (
    err instanceof Anthropic.RateLimitError ||
    err instanceof Anthropic.InternalServerError ||
    err instanceof Anthropic.APIConnectionError
  );
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = DEFAULT_RETRY_OPTIONS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryableAnthropicError(err) || attempt === options.maxAttempts) {
        throw err;
      }
      await sleep(options.baseDelayMs * 2 ** (attempt - 1));
    }
  }

  throw lastError;
}
