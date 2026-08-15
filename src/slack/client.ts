import { WebClient } from "@slack/web-api";
import type {
  AuthTestResponse,
  ChatGetPermalinkResponse,
  ConversationsHistoryResponse,
  ConversationsInfoResponse,
  ConversationsRepliesResponse,
} from "@slack/web-api";

export interface HistoryPageOptions {
  limit?: number;
  oldest?: string;
  cursor?: string;
}

export interface RepliesPageOptions {
  limit?: number;
  cursor?: string;
}

/**
 * A deliberately read-only Slack client wrapper.
 *
 * This module must never gain a method that calls a mutating Slack API
 * (chat.postMessage, chat.update, chat.delete, reactions.add,
 * conversations.archive, conversations.rename, pins.add, etc). Publishing
 * to Slack is implemented in a separate, guarded module added in a later
 * milestone — keeping this wrapper read-only means every caller of this
 * client is structurally incapable of writing to Slack, including the
 * production, read-only source channel.
 *
 * chat.getPermalink is included here because it only retrieves a link to
 * an existing message — it does not post, edit, or otherwise mutate
 * anything in Slack.
 */
export interface SlackReadOnlyClient {
  authTest(): Promise<AuthTestResponse>;
  getChannelInfo(channelId: string): Promise<ConversationsInfoResponse>;
  getHistoryPage(channelId: string, options: HistoryPageOptions): Promise<ConversationsHistoryResponse>;
  getRepliesPage(
    channelId: string,
    threadTs: string,
    options?: RepliesPageOptions,
  ): Promise<ConversationsRepliesResponse>;
  getPermalink(channelId: string, messageTs: string): Promise<ChatGetPermalinkResponse>;
}

export function createSlackReadOnlyClient(token: string): SlackReadOnlyClient {
  const client = new WebClient(token);

  return {
    authTest: () => client.auth.test(),
    getChannelInfo: (channelId) => client.conversations.info({ channel: channelId }),
    getHistoryPage: (channelId, { limit, oldest, cursor }) =>
      client.conversations.history({ channel: channelId, limit, oldest, cursor }),
    getRepliesPage: (channelId, threadTs, options) =>
      client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: options?.limit,
        cursor: options?.cursor,
      }),
    getPermalink: (channelId, messageTs) =>
      client.chat.getPermalink({ channel: channelId, message_ts: messageTs }),
  };
}
