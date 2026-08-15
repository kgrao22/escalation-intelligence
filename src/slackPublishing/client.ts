import { WebClient } from "@slack/web-api";
import { assertWriteTarget, PublicationSafetyError } from "./safety.js";
import { DEFAULT_SLACK_RETRY_OPTIONS, withSlackRetry, type SlackRetryOptions } from "./retry.js";

export interface SlackPostRequest {
  channel: string;
  text: string;
  /** Present only for thread replies; the overview is posted without it. */
  thread_ts?: string;
}

export interface SlackPostResponse {
  ok?: boolean;
  ts?: string;
}

/**
 * Decoupled from the SDK so the publisher's logic can be exercised without any
 * possibility of reaching Slack from a test.
 */
export type SlackPostFn = (request: SlackPostRequest) => Promise<SlackPostResponse>;

export class SlackPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackPublishError";
  }
}

/**
 * The only function in this codebase that performs a Slack write.
 *
 * `chat.postMessage` is the sole method exposed. The read-only source client
 * (src/slack/client.ts) is untouched and still has no write methods at all, so
 * the read and write surfaces remain structurally separate.
 */
export function createSlackPostFn(token: string): SlackPostFn {
  const client = new WebClient(token);
  return async ({ channel, text, thread_ts }) => {
    const response = await client.chat.postMessage({ channel, text, ...(thread_ts ? { thread_ts } : {}) });
    return { ok: response.ok, ts: response.ts };
  };
}

export interface Publisher {
  postOverview(text: string): Promise<string>;
  postThreadReply(text: string, threadTs: string): Promise<string>;
}

function assertUsableResponse(response: SlackPostResponse, label: string): string {
  if (response.ok !== true) {
    throw new SlackPublishError(`Slack rejected the ${label} (ok was not true).`);
  }
  if (typeof response.ts !== "string" || response.ts === "") {
    throw new SlackPublishError(`Slack accepted the ${label} but returned no usable ts.`);
  }
  return response.ts;
}

/**
 * Wraps the raw post function with the per-write channel guard. Every method
 * validates the destination immediately before calling out, so no code path
 * can post anywhere except the single permitted channel.
 */
export function createPublisher(
  postFn: SlackPostFn,
  destinationChannelId: string,
  retryOptions: SlackRetryOptions = DEFAULT_SLACK_RETRY_OPTIONS,
  sleep?: (ms: number) => Promise<void>,
): Publisher {
  const post = async (text: string, threadTs: string | undefined, label: string): Promise<string> => {
    assertWriteTarget(destinationChannelId);
    const response = await withSlackRetry(
      () =>
        postFn({
          channel: destinationChannelId,
          text,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        }),
      retryOptions,
      sleep,
    );
    return assertUsableResponse(response, label);
  };

  return {
    postOverview: (text) => post(text, undefined, "overview message"),
    // Async so the guard surfaces as a rejected promise rather than a
    // synchronous throw from a Promise-returning method, which would slip past
    // a caller's .catch().
    postThreadReply: async (text, threadTs) => {
      if (!threadTs) {
        // A reply without a thread_ts would silently become a top-level post,
        // flooding the channel — exactly what the threading model prevents.
        throw new PublicationSafetyError(
          "Refusing to post an issue detail without a thread_ts: it would become a top-level message.",
        );
      }
      return post(text, threadTs, "thread reply");
    },
  };
}
