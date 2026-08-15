import { describe, expect, it, vi } from "vitest";
import type {
  ChatGetPermalinkResponse,
  ConversationsHistoryResponse,
  ConversationsRepliesResponse,
} from "@slack/web-api";
import type { SlackReadOnlyClient } from "../src/slack/client.js";
import {
  assembleEscalationThread,
  computeOldestTs,
  fetchAllTopLevelMessages,
  fetchThreadReplies,
  tsToIso,
  type RawTopLevelMessage,
} from "../src/slack/escalationThreads.js";

function makeClient(overrides: Partial<SlackReadOnlyClient> = {}): SlackReadOnlyClient {
  return {
    authTest: () => Promise.resolve({ ok: true }),
    getChannelInfo: () => Promise.resolve({ ok: true }),
    getHistoryPage: () => Promise.resolve({ ok: true, messages: [] } as ConversationsHistoryResponse),
    getRepliesPage: () => Promise.resolve({ ok: true, messages: [] } as ConversationsRepliesResponse),
    getPermalink: () =>
      Promise.resolve({ ok: true, permalink: "https://example.slack.com/archives/C1/p1" } as ChatGetPermalinkResponse),
    ...overrides,
  };
}

describe("computeOldestTs", () => {
  it("computes a Slack-style ts N days before now", () => {
    const now = new Date("2026-08-09T00:00:00.000Z");
    const oldest = computeOldestTs(30, now);
    const expectedSeconds = (now.getTime() - 30 * 24 * 60 * 60 * 1000) / 1000;
    expect(Number.parseFloat(oldest)).toBeCloseTo(expectedSeconds, 5);
  });

  it("produces a smaller (earlier) ts for a larger days-back window", () => {
    const now = new Date("2026-08-09T00:00:00.000Z");
    const oldest30 = Number.parseFloat(computeOldestTs(30, now));
    const oldest90 = Number.parseFloat(computeOldestTs(90, now));
    expect(oldest90).toBeLessThan(oldest30);
  });
});

describe("tsToIso", () => {
  it("converts a Slack ts to an ISO timestamp", () => {
    expect(tsToIso("1700000000.000000")).toBe(new Date(1700000000 * 1000).toISOString());
  });
});

describe("fetchAllTopLevelMessages (pagination)", () => {
  it("follows response_metadata.next_cursor across multiple pages", async () => {
    const page1: ConversationsHistoryResponse["messages"] = [{ ts: "1.0", user: "U1", text: "first" }];
    const page2: ConversationsHistoryResponse["messages"] = [{ ts: "2.0", user: "U2", text: "second" }];

    const getHistoryPage = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        messages: page1,
        response_metadata: { next_cursor: "cursor-1" },
      } as ConversationsHistoryResponse)
      .mockResolvedValueOnce({
        ok: true,
        messages: page2,
        response_metadata: { next_cursor: "" },
      } as ConversationsHistoryResponse);

    const client = makeClient({ getHistoryPage });

    const results = await fetchAllTopLevelMessages(client, "C1", "0.0");

    expect(results).toHaveLength(2);
    expect(results.map((m) => m.ts)).toEqual(["1.0", "2.0"]);
    expect(getHistoryPage).toHaveBeenCalledTimes(2);
    expect(getHistoryPage).toHaveBeenNthCalledWith(1, "C1", { oldest: "0.0", cursor: undefined, limit: 200 });
    expect(getHistoryPage).toHaveBeenNthCalledWith(2, "C1", { oldest: "0.0", cursor: "cursor-1", limit: 200 });
  });

  it("stops after a single page when there is no next_cursor", async () => {
    const getHistoryPage = vi.fn().mockResolvedValueOnce({
      ok: true,
      messages: [{ ts: "1.0", user: "U1", text: "only message" }],
    } as ConversationsHistoryResponse);

    const client = makeClient({ getHistoryPage });
    const results = await fetchAllTopLevelMessages(client, "C1", "0.0");

    expect(results).toHaveLength(1);
    expect(getHistoryPage).toHaveBeenCalledTimes(1);
  });

  it("maps raw Slack fields onto RawTopLevelMessage", async () => {
    const client = makeClient({
      getHistoryPage: () =>
        Promise.resolve({
          ok: true,
          messages: [
            {
              ts: "1.0",
              user: "U1",
              text: "Bulk upload failed",
              subtype: undefined,
              bot_id: undefined,
              reply_count: 3,
              thread_ts: "1.0",
            },
          ],
        } as ConversationsHistoryResponse),
    });

    const [message] = await fetchAllTopLevelMessages(client, "C1", "0.0");
    expect(message).toEqual<RawTopLevelMessage>({
      ts: "1.0",
      authorId: "U1",
      text: "Bulk upload failed",
      subtype: undefined,
      botId: undefined,
      replyCount: 3,
      threadTs: "1.0",
    });
  });
});

describe("fetchThreadReplies", () => {
  it("excludes the parent message and paginates replies", async () => {
    const getRepliesPage = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        messages: [
          { ts: "1.0", user: "U1", text: "root message" },
          { ts: "1.1", user: "U2", text: "reply one" },
        ],
        response_metadata: { next_cursor: "cursor-1" },
      } as ConversationsRepliesResponse)
      .mockResolvedValueOnce({
        ok: true,
        messages: [{ ts: "1.2", user: "U3", text: "reply two" }],
        response_metadata: { next_cursor: "" },
      } as ConversationsRepliesResponse);

    const client = makeClient({ getRepliesPage });
    const replies = await fetchThreadReplies(client, "C1", "1.0");

    expect(replies.map((r) => r.ts)).toEqual(["1.1", "1.2"]);
    expect(replies[0]).toMatchObject({ ts: "1.1", authorId: "U2", text: "reply one" });
  });

  it("propagates Slack errors instead of swallowing them", async () => {
    class FakeSlackError extends Error {
      data = { error: "missing_scope" };
    }
    const client = makeClient({
      getRepliesPage: () => Promise.reject(new FakeSlackError("boom")),
    });

    await expect(fetchThreadReplies(client, "C1", "1.0")).rejects.toThrow();
  });
});

describe("assembleEscalationThread", () => {
  it("builds a thread with replies and a permalink for a message with replies", async () => {
    const client = makeClient({
      getRepliesPage: () =>
        Promise.resolve({
          ok: true,
          messages: [
            { ts: "1.0", user: "U1", text: "root" },
            { ts: "1.1", user: "U2", text: "reply" },
          ],
        } as ConversationsRepliesResponse),
    });

    const rawMessage: RawTopLevelMessage = {
      ts: "1.0",
      authorId: "U1",
      text: "root",
      replyCount: 1,
    };

    const thread = await assembleEscalationThread(client, "C1", rawMessage);

    expect(thread.channelId).toBe("C1");
    expect(thread.rootTs).toBe("1.0");
    expect(thread.replies).toHaveLength(1);
    expect(thread.replyCount).toBe(1);
    expect(thread.permalink).toBe("https://example.slack.com/archives/C1/p1");
  });

  it("does not call conversations.replies for a message with no replies", async () => {
    const getRepliesPage = vi.fn();
    const client = makeClient({ getRepliesPage });

    const rawMessage: RawTopLevelMessage = { ts: "1.0", text: "no replies here", replyCount: 0 };
    const thread = await assembleEscalationThread(client, "C1", rawMessage);

    expect(getRepliesPage).not.toHaveBeenCalled();
    expect(thread.replies).toEqual([]);
  });

  it("leaves permalink undefined (non-fatal) when chat.getPermalink fails", async () => {
    const client = makeClient({
      getPermalink: () => Promise.reject(new Error("permalink unavailable")),
    });

    const rawMessage: RawTopLevelMessage = { ts: "1.0", text: "no replies here", replyCount: 0 };
    const thread = await assembleEscalationThread(client, "C1", rawMessage);

    expect(thread.permalink).toBeUndefined();
  });
});
