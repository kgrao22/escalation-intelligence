import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { outputFilePath, writeFetchOutput, type FetchOutput } from "../src/persistence/fetchOutput.js";
import type { EscalationThread } from "../src/slack/escalationThreads.js";

describe("outputFilePath", () => {
  it("includes the lookback window and the fetch date", () => {
    const filePath = outputFilePath("/tmp/data/slack", new Date("2026-08-09T12:34:56.000Z"), 90);
    expect(filePath).toBe(path.join("/tmp/data/slack", "escalations-90d-2026-08-09.json"));
  });

  it("does not collide across lookback windows on the same day", () => {
    const sameDay = new Date("2026-08-09T12:34:56.000Z");
    const thirtyDay = outputFilePath("/tmp/data/slack", sameDay, 30);
    const ninetyDay = outputFilePath("/tmp/data/slack", sameDay, 90);

    expect(thirtyDay).not.toBe(ninetyDay);
    expect(thirtyDay).toContain("escalations-30d-2026-08-09.json");
    expect(ninetyDay).toContain("escalations-90d-2026-08-09.json");
  });
});

describe("writeFetchOutput", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes valid JSON matching the documented output shape, creating directories as needed", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "escalation-intelligence-test-"));
    const nestedDir = path.join(dir, "data", "slack");
    const filePath = outputFilePath(nestedDir, new Date("2026-08-09T00:00:00.000Z"), 30);

    const thread: EscalationThread = {
      channelId: "C0SOURCE0000",
      rootTs: "1.0",
      postedAt: "2026-08-01T00:00:00.000Z",
      authorId: "U1",
      rootText: "Bulk upload failed",
      replyCount: 1,
      permalink: "https://example.slack.com/archives/C0SOURCE0000/p1",
      replies: [{ ts: "1.1", postedAt: "2026-08-01T00:05:00.000Z", authorId: "U2", text: "looking into it" }],
    };

    const output: FetchOutput = {
      metadata: {
        channelId: "C0SOURCE0000",
        daysBack: 30,
        fetchedAt: "2026-08-09T00:00:00.000Z",
        rawTopLevelMessages: 5,
        systemMessagesFiltered: 1,
        analysisThreads: 4,
        threadsWithReplies: 1,
        totalReplies: 1,
      },
      threads: [thread],
    };

    await writeFetchOutput(output, filePath);

    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as FetchOutput;

    expect(parsed.metadata).toEqual(output.metadata);
    expect(parsed.threads).toEqual(output.threads);
    expect(Object.keys(parsed).sort()).toEqual(["metadata", "threads"]);
  });
});
