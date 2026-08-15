import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseSlackPublishArgs } from "../../src/cli/slackPublishArgs.js";
import {
  analysePublicationState,
  publicationReceiptFilePath,
  receiptIndicatesCompletePublication,
  type PublicationReceipt,
} from "../../src/persistence/publicationReceipt.js";
import type { SlackPreviewOutput } from "../../src/persistence/slackPreviewOutput.js";
import { createPublisher, type SlackPostFn, type SlackPostRequest } from "../../src/slackPublishing/client.js";
import { buildPublicationPlan } from "../../src/slackPublishing/publishPlan.js";
import { runPublication } from "../../src/slackPublishing/runPublication.js";

const DEST = "C0DEST00000";
const START = new Date("2026-08-12T09:00:00.000Z");

function preview(issueCount = 3): SlackPreviewOutput {
  return {
    metadata: {
      reportInputFile: "data/intelligence/report-90d-2026-08-11.json",
      recommendationsInputFile: "data/intelligence/recommendations-90d-2026-08-11.json",
      createdAt: START.toISOString(),
      sourceWindowDays: 90,
      messageCount: issueCount + 1,
      slackDestinationChannelId: DEST,
      posted: false,
      omittedGroupIds: [],
      longestMessageCharacterCount: 100,
    },
    overview: { text: "OVERVIEW TEXT", characterCount: 13 },
    issues: Array.from({ length: issueCount }, (_, i) => ({
      text: `ISSUE ${i + 1} TEXT`,
      groupId: `grp_${i + 1}`,
      characterCount: 12,
    })),
  };
}

function sequentialPostFn(): SlackPostFn {
  let counter = 0;
  return vi.fn(async () => {
    counter += 1;
    return { ok: true, ts: `170000000${counter}.0001` };
  });
}

async function publish(plan: ReturnType<typeof buildPublicationPlan>, postFn: SlackPostFn) {
  return runPublication({
    plan,
    publisher: createPublisher(postFn, DEST, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 }),
    previewInputFile: "data/intelligence/slack-preview-90d-2026-08-11.json",
    destinationChannelId: DEST,
    runId: "abc12345",
    startedAt: START,
    now: () => START,
  });
}

describe("buildPublicationPlan — limit semantics", () => {
  it("plans overview first, then every issue as a thread reply", () => {
    const plan = buildPublicationPlan(preview(3));
    expect(plan).toHaveLength(4);
    expect(plan[0]).toMatchObject({ index: 1, type: "overview", threadReply: false });
    expect(plan.slice(1).every((m) => m.type === "issue" && m.threadReply)).toBe(true);
  });

  it("--limit=1 publishes only the overview", () => {
    const plan = buildPublicationPlan(preview(7), 1);
    expect(plan).toHaveLength(1);
    expect(plan[0]?.type).toBe("overview");
  });

  it("--limit=2 publishes the overview plus the first issue", () => {
    const plan = buildPublicationPlan(preview(7), 2);
    expect(plan.map((m) => m.type)).toEqual(["overview", "issue"]);
    expect(plan[1]?.groupId).toBe("grp_1");
  });

  it("--limit=8 publishes the overview plus all seven issues", () => {
    expect(buildPublicationPlan(preview(7), 8)).toHaveLength(8);
  });

  it("caps a limit larger than the available messages", () => {
    expect(buildPublicationPlan(preview(3), 99)).toHaveLength(4);
  });

  it("publishes everything when no limit is supplied", () => {
    expect(buildPublicationPlan(preview(7))).toHaveLength(8);
  });

  it("passes the preview text through unchanged", () => {
    const plan = buildPublicationPlan(preview(1));
    expect(plan[0]?.text).toBe("OVERVIEW TEXT");
    expect(plan[1]?.text).toBe("ISSUE 1 TEXT");
  });
});

describe("runPublication — threading and success", () => {
  it("posts the overview top-level and every issue into its thread", async () => {
    const postFn = sequentialPostFn();
    const receipt = await publish(buildPublicationPlan(preview(3)), postFn);

    const requests = vi.mocked(postFn).mock.calls.map((call) => call[0] as SlackPostRequest);
    expect(requests[0]?.thread_ts).toBeUndefined();
    expect(requests.slice(1).every((r) => r.thread_ts === "1700000001.0001")).toBe(true);
    expect(receipt.status).toBe("completed");
    expect(receipt.overviewTs).toBe("1700000001.0001");
  });

  it("never posts an issue as a second top-level message", async () => {
    const postFn = sequentialPostFn();
    await publish(buildPublicationPlan(preview(3)), postFn);

    const topLevel = vi
      .mocked(postFn)
      .mock.calls.map((call) => call[0] as SlackPostRequest)
      .filter((request) => request.thread_ts === undefined);
    expect(topLevel).toHaveLength(1);
  });

  it("sends every message to the permitted destination only", async () => {
    const postFn = sequentialPostFn();
    await publish(buildPublicationPlan(preview(3)), postFn);

    for (const call of vi.mocked(postFn).mock.calls) {
      expect((call[0] as SlackPostRequest).channel).toBe(DEST);
      expect((call[0] as SlackPostRequest).channel).not.toBe("C0SOURCE0000");
    }
  });

  it("passes the reviewed text through byte-for-byte", async () => {
    const postFn = sequentialPostFn();
    await publish(buildPublicationPlan(preview(2)), postFn);

    const texts = vi.mocked(postFn).mock.calls.map((call) => (call[0] as SlackPostRequest).text);
    expect(texts).toEqual(["OVERVIEW TEXT", "ISSUE 1 TEXT", "ISSUE 2 TEXT"]);
  });

  it("records a receipt describing exactly what landed", async () => {
    const receipt = await publish(buildPublicationPlan(preview(2)), sequentialPostFn());

    expect(receipt.publishedMessages).toHaveLength(3);
    expect(receipt.publishedMessages[0]).toMatchObject({ index: 1, type: "overview", status: "success" });
    expect(receipt.publishedMessages[1]).toMatchObject({ index: 2, type: "issue", groupId: "grp_1" });
    expect(receipt.failures).toEqual([]);
    expect(receipt.requestedMessageCount).toBe(3);
  });

  it("publishes only the overview under --limit=1", async () => {
    const postFn = sequentialPostFn();
    const receipt = await publish(buildPublicationPlan(preview(7), 1), postFn);

    expect(postFn).toHaveBeenCalledTimes(1);
    expect(receipt.publishedMessages).toHaveLength(1);
    expect(receipt.status).toBe("completed");
  });
});

describe("runPublication — failure handling", () => {
  it("aborts before any replies when the overview fails", async () => {
    const postFn: SlackPostFn = vi.fn(async () => ({ ok: false }));
    const receipt = await publish(buildPublicationPlan(preview(3)), postFn);

    expect(receipt.status).toBe("failed");
    expect(receipt.overviewTs).toBeNull();
    expect(receipt.publishedMessages).toHaveLength(0);
    // Only the overview attempt happened; no replies were tried.
    expect(postFn).toHaveBeenCalledTimes(1);
  });

  it("records a partial failure and keeps the successful posts", async () => {
    let call = 0;
    const postFn: SlackPostFn = vi.fn(async () => {
      call += 1;
      if (call === 3) {
        throw new Error("slack exploded");
      }
      return { ok: true, ts: `170000000${call}.0001` };
    });

    const receipt = await publish(buildPublicationPlan(preview(3)), postFn);

    expect(receipt.status).toBe("partial_failure");
    expect(receipt.publishedMessages).toHaveLength(3);
    expect(receipt.failures).toHaveLength(1);
    expect(receipt.failures[0]).toMatchObject({ index: 3, type: "issue", groupId: "grp_2" });
  });

  it("continues past a failed reply rather than abandoning the rest", async () => {
    let call = 0;
    const postFn: SlackPostFn = vi.fn(async () => {
      call += 1;
      if (call === 2) {
        throw new Error("transient");
      }
      return { ok: true, ts: `170000000${call}.0001` };
    });

    const receipt = await publish(buildPublicationPlan(preview(3)), postFn);
    expect(receipt.publishedMessages.filter((m) => m.type === "issue")).toHaveLength(2);
  });

  it("never contains the bot token in the receipt", async () => {
    const receipt = await publish(buildPublicationPlan(preview(2)), sequentialPostFn());
    expect(JSON.stringify(receipt)).not.toContain("xoxb-");
  });
});

describe("publication state analysis", () => {
  const PREVIEW_FILE = "data/intelligence/slack-preview-90d-2026-08-11.json";

  function receipt(overrides: Partial<PublicationReceipt> = {}): PublicationReceipt {
    return {
      runId: "run00001",
      previewInputFile: PREVIEW_FILE,
      destinationChannelId: DEST,
      startedAt: START.toISOString(),
      completedAt: START.toISOString(),
      overviewTs: "1786471046.597319",
      status: "completed",
      requestedMessageCount: 1,
      publishedMessages: [{ index: 1, type: "overview", slackTs: "1786471046.597319", status: "success" }],
      failures: [],
      ...overrides,
    };
  }

  it("does not treat a successful --limit=1 run as a fully published preview", () => {
    const state = analysePublicationState([receipt()], PREVIEW_FILE, DEST, 8);
    expect(state.fullyPublished).toBe(false);
    expect(state.publishedMessageCount).toBe(1);
    expect(state.missingIndexes).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it("reads the overview ts from an older receipt lacking the new fields", () => {
    const state = analysePublicationState([receipt()], PREVIEW_FILE, DEST, 8);
    expect(state.overviewPublished).toBe(true);
    expect(state.overviewTs).toBe("1786471046.597319");
  });

  it("infers incompleteness for an old receipt that requested fewer messages than available", () => {
    expect(receiptIndicatesCompletePublication(receipt(), 8)).toBe(false);
  });

  it("prefers an explicit publicationCompleteForPreview flag when present", () => {
    expect(receiptIndicatesCompletePublication(receipt({ publicationCompleteForPreview: true }), 8)).toBe(true);
    expect(
      receiptIndicatesCompletePublication(receipt({ requestedMessageCount: 8, publicationCompleteForPreview: false }), 8),
    ).toBe(false);
  });

  it("reports full publication once every index has landed across runs", () => {
    const resumeReceipt = receipt({
      runId: "run00002",
      startedAt: "2026-08-12T10:00:00.000Z",
      publishedMessages: Array.from({ length: 7 }, (_, i) => ({
        index: i + 2,
        type: "issue" as const,
        slackTs: `170000000${i}.1`,
        status: "success" as const,
      })),
    });

    const state = analysePublicationState([receipt(), resumeReceipt], PREVIEW_FILE, DEST, 8);
    expect(state.fullyPublished).toBe(true);
    expect(state.missingIndexes).toEqual([]);
  });

  it("counts an index recorded in two receipts only once", () => {
    const state = analysePublicationState([receipt(), receipt({ runId: "dup" })], PREVIEW_FILE, DEST, 8);
    expect(state.publishedMessageCount).toBe(1);
  });

  it("ignores receipts for a different preview or destination", () => {
    const other = receipt({ previewInputFile: "data/intelligence/slack-preview-90d-2026-09-01.json" });
    const otherChannel = receipt({ destinationChannelId: "C0OTHER" });

    expect(analysePublicationState([other, otherChannel], PREVIEW_FILE, DEST, 8).hasPriorPublication).toBe(false);
  });

  it("reports no prior publication when nothing succeeded", () => {
    const failed = receipt({ status: "failed", overviewTs: null, publishedMessages: [] });
    const state = analysePublicationState([failed], PREVIEW_FILE, DEST, 8);

    expect(state.hasPriorPublication).toBe(false);
    expect(state.overviewPublished).toBe(false);
  });

  it("computes remaining indexes after a partial resume failure", () => {
    const partialResume = receipt({
      runId: "run00002",
      status: "partial_failure",
      startedAt: "2026-08-12T10:00:00.000Z",
      publishedMessages: [
        { index: 2, type: "issue", slackTs: "1.1", status: "success" },
        { index: 3, type: "issue", slackTs: "1.2", status: "success" },
      ],
      failures: [{ index: 4, type: "issue", error: "boom" }],
    });

    const state = analysePublicationState([receipt(), partialResume], PREVIEW_FILE, DEST, 8);
    expect(state.missingIndexes).toEqual([4, 5, 6, 7, 8]);
    expect(state.fullyPublished).toBe(false);
  });

  it("names receipts uniquely per run", () => {
    const first = publicationReceiptFilePath("/d", START, "abc12345", "90d");
    const second = publicationReceiptFilePath("/d", START, "def67890", "90d");
    expect(first).toBe(path.join("/d", "slack-publication-90d-2026-08-12-abc12345.json"));
    expect(first).not.toBe(second);
  });
});

describe("parseSlackPublishArgs — fail closed", () => {
  it("defaults publish to false so the default invocation cannot write", () => {
    expect(parseSlackPublishArgs([])).toEqual({
      input: undefined,
      publish: false,
      resume: false,
      limit: undefined,
    });
  });

  it("requires an explicit --publish flag to enable writes", () => {
    expect(parseSlackPublishArgs(["--publish"]).publish).toBe(true);
    expect(parseSlackPublishArgs(["--input=x.json"]).publish).toBe(false);
  });

  it("rejects a destination override outright", () => {
    expect(() => parseSlackPublishArgs(["--channel=C09999999"])).toThrow(/not supported/);
    expect(() => parseSlackPublishArgs(["--channel", "C09999999"])).toThrow(/fixed in code/);
  });

  it("parses and validates --limit", () => {
    expect(parseSlackPublishArgs(["--limit=1"]).limit).toBe(1);
    expect(() => parseSlackPublishArgs(["--limit=0"])).toThrow(/Invalid --limit/);
    expect(() => parseSlackPublishArgs(["--limit=abc"])).toThrow(/Invalid --limit/);
  });
});

describe("publication layer boundaries", () => {
  it("the read-only source client still invokes no write methods", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src/slack/client.ts"), "utf8");
    // Match actual invocations, not the doc comment that lists the forbidden
    // methods by name.
    expect(source).not.toMatch(/client\.chat\.postMessage\s*\(/);
    expect(source).not.toMatch(/client\.chat\.update\s*\(/);
    expect(source).not.toMatch(/client\.chat\.delete\s*\(/);
    expect(source).not.toMatch(/client\.reactions\.add\s*\(/);
    expect(source).not.toMatch(/client\.conversations\.(archive|rename)\s*\(/);
  });

  it("never calls Anthropic or Voyage during publication", async () => {
    for (const file of [
      "src/cli/intelligence-slack-publish.ts",
      "src/slackPublishing/runPublication.ts",
      "src/slackPublishing/client.ts",
      "src/slackPublishing/publishPlan.ts",
    ]) {
      const source = await readFile(path.resolve(process.cwd(), file), "utf8");
      expect(source).not.toContain("@anthropic-ai/sdk");
      expect(source).not.toContain("voyageai.com");
      expect(source).not.toContain("createStructuredParseFn");
    }
  });

  it("never reads Slack history during publication", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src/slackPublishing/client.ts"), "utf8");
    expect(source).not.toContain("conversations.history");
    expect(source).not.toContain("conversations.replies");
  });

  it("never logs the bot token", async () => {
    for (const file of ["src/cli/intelligence-slack-publish.ts", "src/slackPublishing/client.ts"]) {
      const source = await readFile(path.resolve(process.cwd(), file), "utf8");
      expect(source).not.toMatch(/console\.log\([^)]*SLACK_BOT_TOKEN/);
    }
  });

  it("does not mutate the reviewed preview artifact", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src/cli/intelligence-slack-publish.ts"), "utf8");
    expect(source).not.toContain("writeSlackPreviewOutput");
    expect(source).not.toMatch(/posted\s*[:=]\s*true/);
  });
});
