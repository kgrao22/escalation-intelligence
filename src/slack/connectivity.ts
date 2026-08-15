import type { SlackReadOnlyClient } from "./client.js";

export interface AuthCheckResult {
  ok: boolean;
  team?: string;
  user?: string;
  botId?: string;
}

export interface ChannelCheckResult {
  channelId: string;
  ok: boolean;
  name?: string;
  isMember?: boolean;
  errorCode?: string;
}

export interface RecentMessageSummary {
  ts: string;
  authorId: string | undefined;
  hasReplies: boolean;
  replyCount: number;
  preview: string;
}

const MAX_PREVIEW_LENGTH = 60;

/**
 * Extracts Slack's machine-readable error code (e.g. "missing_scope",
 * "not_in_channel") from a thrown WebClient error, without assuming a
 * specific error class shape beyond the documented `data.error` field.
 */
export function extractSlackErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: unknown }).data;
    if (data && typeof data === "object" && "error" in data) {
      const code = (data as { error?: unknown }).error;
      return typeof code === "string" ? code : undefined;
    }
  }
  return undefined;
}

export function truncatePreview(text: string | undefined, maxLength = MAX_PREVIEW_LENGTH): string {
  if (!text) {
    return "";
  }
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength)}…` : singleLine;
}

export async function checkAuth(client: SlackReadOnlyClient): Promise<AuthCheckResult> {
  const res = await client.authTest();
  return {
    ok: Boolean(res.ok),
    team: res.team,
    user: res.user,
    botId: res.bot_id,
  };
}

export async function checkChannelAccess(
  client: SlackReadOnlyClient,
  channelId: string,
): Promise<ChannelCheckResult> {
  try {
    const res = await client.getChannelInfo(channelId);
    return {
      channelId,
      ok: Boolean(res.ok),
      name: res.channel?.name,
      isMember: res.channel?.is_member,
    };
  } catch (err) {
    return {
      channelId,
      ok: false,
      errorCode: extractSlackErrorCode(err),
    };
  }
}

export async function fetchRecentMessageSummaries(
  client: SlackReadOnlyClient,
  channelId: string,
  limit: number,
): Promise<RecentMessageSummary[]> {
  const res = await client.getHistoryPage(channelId, { limit });
  const messages = res.messages ?? [];
  return messages.map((message) => ({
    ts: message.ts ?? "",
    authorId: message.user,
    hasReplies: Boolean(message.reply_count && message.reply_count > 0),
    replyCount: message.reply_count ?? 0,
    preview: truncatePreview(message.text),
  }));
}

/**
 * Human-readable guidance for common Slack error codes, so the probe can
 * explain what to fix instead of just printing a bare error code.
 */
export function explainSlackErrorCode(errorCode: string): string {
  switch (errorCode) {
    case "missing_scope":
      return (
        "The bot token is missing a required OAuth scope. Add channels:read and " +
        "channels:history (or groups:read / groups:history if the channel is private) " +
        "to the Slack app, then reinstall it to the workspace."
      );
    case "not_in_channel":
      return (
        "The bot is not a member of this channel. Invite it with `/invite @YourBotName` " +
        "in the channel, or verify the app has scopes that allow reading public channels " +
        "without joining."
      );
    case "channel_not_found":
      return "No channel was found for this ID. Double-check the channel ID and that the bot's workspace matches.";
    case "invalid_auth":
    case "not_authed":
      return "The Slack bot token appears to be invalid or expired. Check SLACK_BOT_TOKEN in .env.local.";
    case "account_inactive":
      return "The Slack bot token's account is inactive. A new token will need to be issued.";
    default:
      return `Slack returned error code "${errorCode}". See https://api.slack.com/methods for details.`;
  }
}

export function formatTimestamp(slackTs: string): string {
  const seconds = Number.parseFloat(slackTs);
  if (Number.isNaN(seconds)) {
    return slackTs;
  }
  return new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}
