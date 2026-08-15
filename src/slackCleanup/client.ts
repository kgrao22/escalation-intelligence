import { WebClient } from "@slack/web-api";
import { assertWriteTarget } from "../slackPublishing/safety.js";

export interface SlackDeleteRequest {
  channel: string;
  ts: string;
}

export interface SlackDeleteResponse {
  ok: boolean;
  /** Slack's error code, e.g. "message_not_found". */
  error?: string;
}

/**
 * Injected rather than imported by business logic, so a test can never reach
 * the network.
 */
export type SlackDeleteFn = (request: SlackDeleteRequest) => Promise<SlackDeleteResponse>;

/**
 * `chat.delete` is the sole method exposed. Reuses the same WebClient stack and
 * bot token as the publisher; the bot can only delete messages it authored.
 * `assertWriteTarget` re-checks the channel on every call, so a bad channel can
 * never reach Slack even if a caller skipped an earlier guard.
 */
export function createSlackDeleteFn(token: string): SlackDeleteFn {
  const client = new WebClient(token);
  return async ({ channel, ts }) => {
    assertWriteTarget(channel);
    try {
      const response = await client.chat.delete({ channel, ts });
      return { ok: Boolean(response.ok) };
    } catch (err) {
      const error = (err as { data?: { error?: string } })?.data?.error;
      if (error) {
        return { ok: false, error };
      }
      throw err;
    }
  };
}
