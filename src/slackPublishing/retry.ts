export interface SlackRetryOptions {
  /** Total attempts including the first — bounded, never infinite. */
  maxAttempts: number;
  baseDelayMs: number;
  /** Upper bound on any single wait, so a huge Retry-After cannot hang a run. */
  maxDelayMs: number;
}

export const DEFAULT_SLACK_RETRY_OPTIONS: SlackRetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
};

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Slack signals rate limiting either through its SDK error code or the payload. */
export function isRateLimited(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const candidate = err as { code?: unknown; data?: { error?: unknown } };
  return (
    candidate.code === "slack_webapi_rate_limited_error" ||
    candidate.data?.error === "ratelimited"
  );
}

function isServerError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const candidate = err as { status?: unknown; statusCode?: unknown };
  const status = readNumber(candidate.status) ?? readNumber(candidate.statusCode);
  return status !== undefined && status >= 500;
}

/**
 * Only rate limits and transient server errors are worth retrying. A
 * validation failure (`invalid_auth`, `channel_not_found`, `not_in_channel`)
 * will fail identically every time, and retrying a write that may already have
 * succeeded risks duplicate posts.
 */
export function isRetryableSlackError(err: unknown): boolean {
  return isRateLimited(err) || isServerError(err);
}

/** Slack's Retry-After, in seconds, wherever the SDK surfaced it. */
export function retryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const candidate = err as { retryAfter?: unknown; data?: { retry_after?: unknown } };
  const seconds = readNumber(candidate.retryAfter) ?? readNumber(candidate.data?.retry_after);
  return seconds === undefined ? undefined : seconds * 1000;
}

export async function withSlackRetry<T>(
  fn: () => Promise<T>,
  options: SlackRetryOptions = DEFAULT_SLACK_RETRY_OPTIONS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryableSlackError(err) || attempt === options.maxAttempts) {
        throw err;
      }
      const backoff = options.baseDelayMs * 2 ** (attempt - 1);
      await sleep(Math.min(retryAfterMs(err) ?? backoff, options.maxDelayMs));
    }
  }

  throw lastError;
}
