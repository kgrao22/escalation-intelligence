import { describe, expect, it } from "vitest";
import type {
  AuthTestResponse,
  ChatGetPermalinkResponse,
  ConversationsHistoryResponse,
  ConversationsInfoResponse,
  ConversationsRepliesResponse,
} from "@slack/web-api";
import type { SlackReadOnlyClient } from "../src/slack/client.js";
import {
  checkAuth,
  checkChannelAccess,
  explainSlackErrorCode,
  extractSlackErrorCode,
  fetchRecentMessageSummaries,
  formatTimestamp,
  truncatePreview,
} from "../src/slack/connectivity.js";

function makeClient(overrides: Partial<SlackReadOnlyClient>): SlackReadOnlyClient {
  return {
    authTest: () => Promise.resolve({ ok: true } as AuthTestResponse),
    getChannelInfo: () => Promise.resolve({ ok: true } as ConversationsInfoResponse),
    getHistoryPage: () => Promise.resolve({ ok: true, messages: [] } as ConversationsHistoryResponse),
    getRepliesPage: () => Promise.resolve({ ok: true, messages: [] } as ConversationsRepliesResponse),
    getPermalink: () => Promise.resolve({ ok: true, permalink: "https://example.slack.com/archives/x/p1" } as ChatGetPermalinkResponse),
    ...overrides,
  };
}

class FakeSlackError extends Error {
  data: { error: string };
  constructor(errorCode: string) {
    super(`slack error: ${errorCode}`);
    this.data = { error: errorCode };
  }
}

describe("extractSlackErrorCode", () => {
  it("extracts the error field from a Slack platform error shape", () => {
    expect(extractSlackErrorCode(new FakeSlackError("missing_scope"))).toBe("missing_scope");
  });

  it("returns undefined for errors without a data.error field", () => {
    expect(extractSlackErrorCode(new Error("boom"))).toBeUndefined();
    expect(extractSlackErrorCode("not an error object")).toBeUndefined();
  });
});

describe("explainSlackErrorCode", () => {
  it("gives specific guidance for missing_scope", () => {
    expect(explainSlackErrorCode("missing_scope")).toMatch(/scope/i);
  });

  it("gives specific guidance for not_in_channel", () => {
    expect(explainSlackErrorCode("not_in_channel")).toMatch(/invite/i);
  });

  it("falls back to a generic message for unknown codes", () => {
    expect(explainSlackErrorCode("some_unknown_code")).toContain("some_unknown_code");
  });
});

describe("truncatePreview", () => {
  it("returns an empty string for undefined text", () => {
    expect(truncatePreview(undefined)).toBe("");
  });

  it("collapses whitespace and leaves short text untouched", () => {
    expect(truncatePreview("hello\n  world")).toBe("hello world");
  });

  it("truncates long text and appends an ellipsis", () => {
    const long = "a".repeat(100);
    const result = truncatePreview(long, 10);
    expect(result).toBe(`${"a".repeat(10)}…`);
  });
});

describe("formatTimestamp", () => {
  it("formats a Slack ts into a readable UTC string", () => {
    expect(formatTimestamp("1700000000.000000")).toBe("2023-11-14 22:13:20 UTC");
  });
});

describe("checkAuth", () => {
  it("returns identity details on success", async () => {
    const client = makeClient({
      authTest: () =>
        Promise.resolve({ ok: true, team: "Acme", user: "escalation-bot", bot_id: "B123" } as AuthTestResponse),
    });
    const result = await checkAuth(client);
    expect(result).toEqual({ ok: true, team: "Acme", user: "escalation-bot", botId: "B123" });
  });
});

describe("checkChannelAccess", () => {
  it("returns ok + name when the channel is accessible", async () => {
    const client = makeClient({
      getChannelInfo: () =>
        Promise.resolve({
          ok: true,
          channel: { name: "escalations", is_member: true },
        } as ConversationsInfoResponse),
    });
    const result = await checkChannelAccess(client, "C0SOURCE0000");
    expect(result).toEqual({
      channelId: "C0SOURCE0000",
      ok: true,
      name: "escalations",
      isMember: true,
    });
  });

  it("captures the Slack error code when access fails", async () => {
    const client = makeClient({
      getChannelInfo: () => Promise.reject(new FakeSlackError("not_in_channel")),
    });
    const result = await checkChannelAccess(client, "C0SOURCE0000");
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("not_in_channel");
  });
});

describe("fetchRecentMessageSummaries", () => {
  it("maps Slack messages to safe, truncated summaries", async () => {
    const client = makeClient({
      getHistoryPage: () =>
        Promise.resolve({
          ok: true,
          messages: [
            { ts: "1700000000.000000", user: "U1", text: "Customer is unable to upload vehicles", reply_count: 4 },
            { ts: "1700000001.000000", user: "U2", text: "Looking into it now" },
          ],
        } as ConversationsHistoryResponse),
    });

    const summaries = await fetchRecentMessageSummaries(client, "C0SOURCE0000", 5);

    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toEqual({
      ts: "1700000000.000000",
      authorId: "U1",
      hasReplies: true,
      replyCount: 4,
      preview: "Customer is unable to upload vehicles",
    });
    expect(summaries[1]?.hasReplies).toBe(false);
    expect(summaries[1]?.replyCount).toBe(0);
  });
});
