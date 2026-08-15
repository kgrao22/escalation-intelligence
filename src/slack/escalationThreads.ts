import type { SlackReadOnlyClient } from "./client.js";

export interface RawTopLevelMessage {
  ts: string;
  authorId?: string;
  text: string;
  subtype?: string;
  botId?: string;
  replyCount: number;
  threadTs?: string;
}

export interface EscalationThreadReply {
  ts: string;
  postedAt: string;
  authorId?: string;
  text: string;
}

export interface EscalationThread {
  channelId: string;
  rootTs: string;
  postedAt: string;
  authorId?: string;
  rootText: string;
  subtype?: string;
  botId?: string;
  replyCount: number;
  permalink?: string;
  replies: EscalationThreadReply[];
}

export function tsToIso(ts: string): string {
  const seconds = Number.parseFloat(ts);
  if (Number.isNaN(seconds)) {
    return ts;
  }
  return new Date(seconds * 1000).toISOString();
}

export function computeOldestTs(daysBack: number, now: Date = new Date()): string {
  const cutoffMs = now.getTime() - daysBack * 24 * 60 * 60 * 1000;
  return (cutoffMs / 1000).toFixed(6);
}

const PAGE_LIMIT = 200;

/**
 * Fetches every top-level message in the channel with ts >= oldestTs,
 * paginating with Slack's cursor until either Slack reports no further
 * pages or the requested window has been fully retrieved. Slack itself
 * enforces the `oldest` bound server-side, so this never fetches messages
 * older than necessary.
 */
export async function fetchAllTopLevelMessages(
  client: SlackReadOnlyClient,
  channelId: string,
  oldestTs: string,
): Promise<RawTopLevelMessage[]> {
  const results: RawTopLevelMessage[] = [];
  let cursor: string | undefined;

  do {
    const page = await client.getHistoryPage(channelId, { oldest: oldestTs, cursor, limit: PAGE_LIMIT });
    for (const message of page.messages ?? []) {
      results.push({
        ts: message.ts ?? "",
        authorId: message.user,
        text: message.text ?? "",
        subtype: message.subtype,
        botId: message.bot_id,
        replyCount: message.reply_count ?? 0,
        threadTs: message.thread_ts,
      });
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return results;
}

/**
 * Fetches every reply in a thread, paginating as needed. conversations.replies
 * always includes the parent message itself as the first element — that is
 * excluded here since the parent is already represented as the thread root.
 *
 * Any Slack error here (e.g. missing_scope, not_in_channel) is intentionally
 * left to propagate to the caller — callers must stop and explain rather
 * than silently skipping or working around a thread-replies failure.
 */
export async function fetchThreadReplies(
  client: SlackReadOnlyClient,
  channelId: string,
  rootTs: string,
): Promise<EscalationThreadReply[]> {
  const replies: EscalationThreadReply[] = [];
  let cursor: string | undefined;

  do {
    const page = await client.getRepliesPage(channelId, rootTs, { cursor, limit: PAGE_LIMIT });
    for (const message of page.messages ?? []) {
      if (message.ts === rootTs) {
        continue;
      }
      replies.push({
        ts: message.ts ?? "",
        postedAt: tsToIso(message.ts ?? ""),
        authorId: message.user,
        text: message.text ?? "",
      });
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return replies;
}

/**
 * Permalinks are supplementary metadata, not essential to the analysis
 * unit itself — a failure here is logged by the caller as a count, not
 * treated as fatal the way a conversations.replies failure is.
 */
export async function fetchPermalink(
  client: SlackReadOnlyClient,
  channelId: string,
  messageTs: string,
): Promise<string | undefined> {
  try {
    const res = await client.getPermalink(channelId, messageTs);
    return res.permalink;
  } catch {
    return undefined;
  }
}

export async function assembleEscalationThread(
  client: SlackReadOnlyClient,
  channelId: string,
  message: RawTopLevelMessage,
): Promise<EscalationThread> {
  const replies = message.replyCount > 0 ? await fetchThreadReplies(client, channelId, message.ts) : [];
  const permalink = await fetchPermalink(client, channelId, message.ts);

  return {
    channelId,
    rootTs: message.ts,
    postedAt: tsToIso(message.ts),
    authorId: message.authorId,
    rootText: message.text,
    subtype: message.subtype,
    botId: message.botId,
    replyCount: replies.length,
    permalink,
    replies,
  };
}
