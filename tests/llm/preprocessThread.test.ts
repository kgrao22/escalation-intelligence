import { describe, expect, it } from "vitest";
import type { EscalationThread } from "../../src/slack/escalationThreads.js";
import { isJiraSyncNoise, preprocessThreadForLLM } from "../../src/llm/preprocessThread.js";

function makeThread(rootText: string, replyTexts: string[]): EscalationThread {
  return {
    channelId: "C0SOURCE0000",
    rootTs: "1.0",
    postedAt: "2026-08-01T00:00:00.000Z",
    authorId: "U1",
    rootText,
    replyCount: replyTexts.length,
    permalink: "https://example.slack.com/archives/C0SOURCE0000/p1",
    replies: replyTexts.map((text, i) => ({
      ts: `1.${i + 1}`,
      postedAt: "2026-08-01T00:05:00.000Z",
      authorId: "U2",
      text,
    })),
  };
}

describe("isJiraSyncNoise", () => {
  it("flags a Jira task-creation announcement", () => {
    expect(isJiraSyncNoise("@Krishna created a Task UP-4265 for this thread")).toBe(true);
  });

  it("flags a Jira thread-sync announcement", () => {
    expect(isJiraSyncNoise("synced this conversation thread with the Jira work item UP-4265")).toBe(true);
  });

  it("does not flag a normal human reply that happens to contain a Jira URL", () => {
    const text = "Root cause found — see https://jira.example.com/browse/UP-4265 for the fix details.";
    expect(isJiraSyncNoise(text)).toBe(false);
  });

  it("does not flag ordinary technical discussion", () => {
    expect(isJiraSyncNoise("The upload service is timing out on files over 50MB.")).toBe(false);
  });
});

describe("preprocessThreadForLLM", () => {
  it("keeps the root message and all non-noise replies", () => {
    const thread = makeThread("Bulk upload failing", ["Looking into it now", "Found the root cause, fixed"]);
    const cleaned = preprocessThreadForLLM(thread);

    expect(cleaned.combinedText).toContain("ROOT MESSAGE:\nBulk upload failing");
    expect(cleaned.combinedText).toContain("REPLY 1:\nLooking into it now");
    expect(cleaned.combinedText).toContain("REPLY 2:\nFound the root cause, fixed");
    expect(cleaned.originalReplyCount).toBe(2);
    expect(cleaned.keptReplyCount).toBe(2);
    expect(cleaned.jiraNoiseRemoved).toBe(0);
  });

  it("removes Jira-sync-bot noise but keeps real replies, including ones with a Jira URL", () => {
    const thread = makeThread("Bulk upload failing", [
      "@Krishna created a Task UP-4265 for this thread",
      "Root cause: timeout on files over 50MB — see https://jira.example.com/browse/UP-4265",
      "synced this conversation thread with the Jira work item UP-4265",
    ]);

    const cleaned = preprocessThreadForLLM(thread);

    expect(cleaned.combinedText).not.toContain("created a Task UP-4265");
    expect(cleaned.combinedText).not.toContain("synced this conversation thread");
    expect(cleaned.combinedText).toContain("Root cause: timeout on files over 50MB");
    expect(cleaned.originalReplyCount).toBe(3);
    expect(cleaned.keptReplyCount).toBe(1);
    expect(cleaned.jiraNoiseRemoved).toBe(2);
  });

  it("handles a thread with no replies", () => {
    const thread = makeThread("Just a lone message", []);
    const cleaned = preprocessThreadForLLM(thread);
    expect(cleaned.combinedText).toBe("ROOT MESSAGE:\nJust a lone message");
    expect(cleaned.keptReplyCount).toBe(0);
  });
});
