import { describe, expect, it, vi } from "vitest";
import { parseSlackPublishArgs } from "../../src/cli/slackPublishArgs.js";
import {
  analysePublicationState,
  type PublicationReceipt,
} from "../../src/persistence/publicationReceipt.js";
import type { SlackPreviewOutput } from "../../src/persistence/slackPreviewOutput.js";
import { createPublisher, type SlackPostFn, type SlackPostRequest } from "../../src/slackPublishing/client.js";
import { buildResumePlan } from "../../src/slackPublishing/publishPlan.js";
import { runPublication } from "../../src/slackPublishing/runPublication.js";

const DEST = "C0DEST00000";
const PREVIEW_FILE = "data/intelligence/slack-preview-90d-2026-08-11.json";
const OVERVIEW_TS = "1786471046.597319";
const START = new Date("2026-08-12T09:00:00.000Z");

/** Mirrors the real 8-message preview: 1 overview + 7 issue details. */
function preview(issueCount = 7): SlackPreviewOutput {
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
      longestMessageCharacterCount: 1512,
    },
    overview: { text: "OVERVIEW TEXT", characterCount: 13 },
    issues: Array.from({ length: issueCount }, (_, i) => ({
      text: `ISSUE ${i + 1} TEXT`,
      groupId: `grp_${i + 1}`,
      characterCount: 12,
    })),
  };
}

/** The receipt produced by the real --limit=1 run, shape-for-shape. */
function overviewOnlyReceipt(): PublicationReceipt {
  return {
    runId: "e35e2431",
    previewInputFile: PREVIEW_FILE,
    destinationChannelId: DEST,
    startedAt: "2026-08-11T17:57:26.324Z",
    completedAt: "2026-08-11T17:57:26.729Z",
    overviewTs: OVERVIEW_TS,
    status: "completed",
    requestedMessageCount: 1,
    publishedMessages: [{ index: 1, type: "overview", slackTs: OVERVIEW_TS, status: "success" }],
    failures: [],
  };
}

function sequentialPostFn(): SlackPostFn {
  let counter = 0;
  return vi.fn(async () => {
    counter += 1;
    return { ok: true, ts: `179000000${counter}.0001` };
  });
}

describe("--resume flag parsing", () => {
  it("defaults to false", () => {
    expect(parseSlackPublishArgs([]).resume).toBe(false);
  });

  it("is enabled explicitly", () => {
    expect(parseSlackPublishArgs(["--resume"]).resume).toBe(true);
  });

  it("still requires --publish to write", () => {
    const args = parseSlackPublishArgs(["--resume"]);
    expect(args.publish).toBe(false);
    expect(parseSlackPublishArgs(["--resume", "--publish"]).publish).toBe(true);
  });

  it("still rejects a destination override alongside resume", () => {
    expect(() => parseSlackPublishArgs(["--resume", "--channel=C09999999"])).toThrow(/not supported/);
  });
});

describe("buildResumePlan", () => {
  it("excludes the already-published overview", () => {
    const plan = buildResumePlan(preview(), new Set([1]));
    expect(plan.every((message) => message.type === "issue")).toBe(true);
    expect(plan.some((message) => message.index === 1)).toBe(false);
  });

  it("plans exactly the seven outstanding issue replies", () => {
    const plan = buildResumePlan(preview(), new Set([1]));
    expect(plan).toHaveLength(7);
    expect(plan.map((message) => message.index)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(plan.every((message) => message.threadReply)).toBe(true);
  });

  it("skips indexes already landed in an earlier resume", () => {
    const plan = buildResumePlan(preview(), new Set([1, 2, 3]));
    expect(plan.map((message) => message.index)).toEqual([4, 5, 6, 7, 8]);
  });

  it("returns nothing when every message has landed", () => {
    expect(buildResumePlan(preview(), new Set([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual([]);
  });

  it("caps the outstanding messages when a limit is supplied", () => {
    const plan = buildResumePlan(preview(), new Set([1]), 2);
    expect(plan.map((message) => message.index)).toEqual([2, 3]);
  });

  it("preserves the reviewed text unchanged", () => {
    const plan = buildResumePlan(preview(), new Set([1]));
    expect(plan[0]?.text).toBe("ISSUE 1 TEXT");
    expect(plan[6]?.text).toBe("ISSUE 7 TEXT");
  });
});

describe("resume publication against the real receipt shape", () => {
  it("discovers the existing overview ts", () => {
    const state = analysePublicationState([overviewOnlyReceipt()], PREVIEW_FILE, DEST, 8);
    expect(state.overviewTs).toBe(OVERVIEW_TS);
    expect(state.overviewPublished).toBe(true);
    expect(state.fullyPublished).toBe(false);
  });

  it("posts only the seven outstanding replies, never a second overview", async () => {
    const postFn = sequentialPostFn();
    const state = analysePublicationState([overviewOnlyReceipt()], PREVIEW_FILE, DEST, 8);

    const receipt = await runPublication({
      plan: buildResumePlan(preview(), state.publishedIndexes),
      publisher: createPublisher(postFn, DEST, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 }),
      previewInputFile: PREVIEW_FILE,
      destinationChannelId: DEST,
      runId: "resume01",
      startedAt: START,
      resumeOverviewTs: state.overviewTs ?? undefined,
      now: () => START,
    });

    expect(postFn).toHaveBeenCalledTimes(7);
    expect(receipt.status).toBe("completed");
    expect(receipt.publishedMessages.every((message) => message.type === "issue")).toBe(true);
  });

  it("sends every resumed reply with the original overview thread_ts", async () => {
    const postFn = sequentialPostFn();
    const state = analysePublicationState([overviewOnlyReceipt()], PREVIEW_FILE, DEST, 8);

    await runPublication({
      plan: buildResumePlan(preview(), state.publishedIndexes),
      publisher: createPublisher(postFn, DEST, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 }),
      previewInputFile: PREVIEW_FILE,
      destinationChannelId: DEST,
      runId: "resume01",
      startedAt: START,
      resumeOverviewTs: state.overviewTs ?? undefined,
      now: () => START,
    });

    const requests = vi.mocked(postFn).mock.calls.map((call) => call[0] as SlackPostRequest);
    expect(requests).toHaveLength(7);
    expect(requests.every((request) => request.thread_ts === OVERVIEW_TS)).toBe(true);
    // Not one of them is a top-level post.
    expect(requests.some((request) => request.thread_ts === undefined)).toBe(false);
  });

  it("posts every resumed reply to the permitted destination only", async () => {
    const postFn = sequentialPostFn();
    await runPublication({
      plan: buildResumePlan(preview(), new Set([1])),
      publisher: createPublisher(postFn, DEST, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 }),
      previewInputFile: PREVIEW_FILE,
      destinationChannelId: DEST,
      runId: "resume01",
      startedAt: START,
      resumeOverviewTs: OVERVIEW_TS,
      now: () => START,
    });

    for (const call of vi.mocked(postFn).mock.calls) {
      expect((call[0] as SlackPostRequest).channel).toBe(DEST);
    }
  });

  it("marks the preview complete only once all eight indexes have landed", async () => {
    const postFn = sequentialPostFn();
    const state = analysePublicationState([overviewOnlyReceipt()], PREVIEW_FILE, DEST, 8);

    const receipt = await runPublication({
      plan: buildResumePlan(preview(), state.publishedIndexes),
      publisher: createPublisher(postFn, DEST, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 }),
      previewInputFile: PREVIEW_FILE,
      destinationChannelId: DEST,
      runId: "resume01",
      startedAt: START,
      resumeOverviewTs: OVERVIEW_TS,
      now: () => START,
    });

    const combined = analysePublicationState(
      [overviewOnlyReceipt(), { ...receipt, previewInputFile: PREVIEW_FILE, destinationChannelId: DEST }],
      PREVIEW_FILE,
      DEST,
      8,
    );
    expect(combined.fullyPublished).toBe(true);
  });
});

describe("resume after a partial resume failure", () => {
  it("records exactly which indexes succeeded", async () => {
    let call = 0;
    const postFn: SlackPostFn = vi.fn(async () => {
      call += 1;
      if (call === 3) {
        throw new Error("slack exploded");
      }
      return { ok: true, ts: `179000000${call}.0001` };
    });

    const receipt = await runPublication({
      plan: buildResumePlan(preview(), new Set([1])),
      publisher: createPublisher(postFn, DEST, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 }),
      previewInputFile: PREVIEW_FILE,
      destinationChannelId: DEST,
      runId: "resume01",
      startedAt: START,
      resumeOverviewTs: OVERVIEW_TS,
      now: () => START,
    });

    expect(receipt.status).toBe("partial_failure");
    expect(receipt.publishedMessages.map((m) => m.index)).toEqual([2, 3, 5, 6, 7, 8]);
    expect(receipt.failures.map((f) => f.index)).toEqual([4]);
  });

  it("a further resume targets only the still-missing index", async () => {
    const firstResume: PublicationReceipt = {
      runId: "resume01",
      previewInputFile: PREVIEW_FILE,
      destinationChannelId: DEST,
      startedAt: "2026-08-12T09:00:00.000Z",
      completedAt: "2026-08-12T09:00:01.000Z",
      overviewTs: OVERVIEW_TS,
      status: "partial_failure",
      requestedMessageCount: 7,
      publishedMessages: [2, 3, 5, 6, 7, 8].map((index) => ({
        index,
        type: "issue" as const,
        slackTs: `179000000${index}.1`,
        status: "success" as const,
      })),
      failures: [{ index: 4, type: "issue", error: "slack exploded" }],
    };

    const state = analysePublicationState([overviewOnlyReceipt(), firstResume], PREVIEW_FILE, DEST, 8);
    expect(state.missingIndexes).toEqual([4]);

    const plan = buildResumePlan(preview(), state.publishedIndexes);
    expect(plan.map((message) => message.index)).toEqual([4]);
    expect(plan[0]?.text).toBe("ISSUE 3 TEXT");
  });

  it("never reposts an index that already succeeded", () => {
    const published = new Set([1, 2, 3, 5, 6, 7, 8]);
    const plan = buildResumePlan(preview(), published);
    for (const message of plan) {
      expect(published.has(message.index)).toBe(false);
    }
  });
});
