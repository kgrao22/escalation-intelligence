import { describe, expect, it, vi } from "vitest";
import { parseSlackCleanupArgs } from "../src/cli/slackCleanupArgs.js";
import { deletionReceiptFilePath } from "../src/persistence/deletionReceiptOutput.js";
import type { SlackDeleteFn } from "../src/slackCleanup/client.js";
import {
  assertCleanupSafety,
  CleanupSafetyError,
  collectDeletionTargets,
  orderForDeletion,
  receiptMatchesWindow,
  type ReceiptFile,
} from "../src/slackCleanup/collectDeletionTargets.js";
import { runDeletion } from "../src/slackCleanup/runDeletion.js";
import {
  EXPECTED_DESTINATION_CHANNEL_ID,
  FORBIDDEN_SOURCE_CHANNEL_ID,
} from "../src/slackPublishing/safety.js";

const OVERVIEW_TS = "1786471046.597319";
const REPLY_TS = ["1786551479.485239", "1786551572.697109", "1786551573.021029"];

function receipt(
  filename: string,
  overrides: Partial<ReceiptFile["receipt"]> = {},
): ReceiptFile {
  return {
    filename,
    receipt: {
      runId: filename.replace(/\.json$/, "").split("-").at(-1) as string,
      destinationChannelId: EXPECTED_DESTINATION_CHANNEL_ID,
      overviewTs: OVERVIEW_TS,
      status: "completed",
      publishedMessages: [
        { index: 1, type: "overview", slackTs: OVERVIEW_TS, status: "success" },
        { index: 2, type: "issue", slackTs: REPLY_TS[0], status: "success" },
      ],
      ...overrides,
    },
  };
}

describe("receipt discovery is window-scoped", () => {
  it("matches only 90d publication receipts", () => {
    expect(receiptMatchesWindow("slack-publication-90d-2026-08-12-cbcf3c3e.json", "90d")).toBe(true);
    expect(receiptMatchesWindow("slack-publication-180d-2026-08-14-aaaaaaaa.json", "90d")).toBe(false);
    expect(receiptMatchesWindow("slack-deletion-90d-2026-08-14-abc.json", "90d")).toBe(false);
    expect(receiptMatchesWindow("report-90d-2026-08-11.json", "90d")).toBe(false);
  });

  it("never selects a 180d receipt during a 90d cleanup", () => {
    const files = [
      receipt("slack-publication-90d-2026-08-12-cbcf3c3e.json"),
      receipt("slack-publication-180d-2026-08-14-deadbeef.json", {
        overviewTs: "9999999999.000001",
        publishedMessages: [{ index: 1, type: "overview", slackTs: "9999999999.000001", status: "success" }],
      }),
    ];
    const targets = collectDeletionTargets(files, "90d");
    expect(targets.map((t) => t.ts)).not.toContain("9999999999.000001");
    expect(targets.every((t) => t.sourceReceiptFile.includes("-90d-"))).toBe(true);
  });

  it("refuses to operate on 180d publications at all", () => {
    expect(() => assertCleanupSafety([], "180d")).toThrow(/Refusing to delete 180d publications/);
  });
});

describe("timestamp reconstruction from receipts", () => {
  it("collects every successfully published message plus the overview", () => {
    const files = [
      receipt("slack-publication-90d-2026-08-11-e35e2431.json", {
        publishedMessages: [{ index: 1, type: "overview", slackTs: OVERVIEW_TS, status: "success" }],
      }),
      receipt("slack-publication-90d-2026-08-12-cbcf3c3e.json", {
        overviewTs: OVERVIEW_TS,
        publishedMessages: REPLY_TS.map((ts, i) => ({
          index: i + 2, type: "issue", slackTs: ts, status: "success" as const,
        })),
      }),
    ];
    const targets = collectDeletionTargets(files, "90d");
    expect(targets.map((t) => t.ts).sort()).toEqual([OVERVIEW_TS, ...REPLY_TS].sort());
  });

  it("deduplicates a timestamp recorded in several receipts", () => {
    const files = [
      receipt("slack-publication-90d-2026-08-11-aaaaaaaa.json"),
      receipt("slack-publication-90d-2026-08-12-bbbbbbbb.json"),
    ];
    const targets = collectDeletionTargets(files, "90d");
    expect(targets.filter((t) => t.ts === OVERVIEW_TS)).toHaveLength(1);
  });

  it("ignores messages that were not successfully published", () => {
    const files = [
      receipt("slack-publication-90d-2026-08-11-cccccccc.json", {
        overviewTs: null,
        publishedMessages: [
          { index: 1, type: "issue", slackTs: "1786551111.000001", status: "failed" },
          { index: 2, type: "issue", slackTs: REPLY_TS[0], status: "success" },
        ],
      }),
    ];
    expect(collectDeletionTargets(files, "90d").map((t) => t.ts)).toEqual([REPLY_TS[0]]);
  });

  it("tolerates a failed run with no overviewTs", () => {
    const files = [
      receipt("slack-publication-90d-2026-08-11-ab76905f.json", {
        status: "failed", overviewTs: null, publishedMessages: [],
      }),
    ];
    expect(collectDeletionTargets(files, "90d")).toEqual([]);
  });

  it("carries provenance on every target", () => {
    const targets = collectDeletionTargets([receipt("slack-publication-90d-2026-08-12-cbcf3c3e.json")], "90d");
    for (const target of targets) {
      expect(target.sourceReceiptFile).toBe("slack-publication-90d-2026-08-12-cbcf3c3e.json");
      expect(target.sourceRunId).toBeTruthy();
    }
  });
});

describe("deletion order", () => {
  it("puts every reply before the parent", () => {
    const targets = collectDeletionTargets(
      [
        receipt("slack-publication-90d-2026-08-12-cbcf3c3e.json", {
          publishedMessages: [
            { index: 1, type: "overview", slackTs: OVERVIEW_TS, status: "success" },
            ...REPLY_TS.map((ts, i) => ({ index: i + 2, type: "issue", slackTs: ts, status: "success" as const })),
          ],
        }),
      ],
      "90d",
    );

    const parentAt = targets.findIndex((t) => t.kind === "overview");
    expect(parentAt).toBe(targets.length - 1);
    expect(targets.slice(0, parentAt).every((t) => t.kind === "reply")).toBe(true);
  });

  it("is deterministic regardless of input order", () => {
    const base = [
      { ts: REPLY_TS[0] as string, kind: "reply" as const, channelId: EXPECTED_DESTINATION_CHANNEL_ID, sourceReceiptFile: "f", sourceRunId: "r" },
      { ts: OVERVIEW_TS, kind: "overview" as const, channelId: EXPECTED_DESTINATION_CHANNEL_ID, sourceReceiptFile: "f", sourceRunId: "r" },
      { ts: REPLY_TS[1] as string, kind: "reply" as const, channelId: EXPECTED_DESTINATION_CHANNEL_ID, sourceReceiptFile: "f", sourceRunId: "r" },
    ];
    expect(orderForDeletion(base).map((t) => t.ts)).toEqual(orderForDeletion([...base].reverse()).map((t) => t.ts));
  });
});

describe("channel safety", () => {
  it("hard-locks the destination channel", () => {
    const targets = collectDeletionTargets([receipt("slack-publication-90d-2026-08-12-cbcf3c3e.json")], "90d");
    expect(targets.every((t) => t.channelId === EXPECTED_DESTINATION_CHANNEL_ID)).toBe(true);
    expect(() => assertCleanupSafety(targets, "90d")).not.toThrow();
  });

  it("refuses a receipt naming the SOURCE channel", () => {
    const files = [
      receipt("slack-publication-90d-2026-08-12-cbcf3c3e.json", {
        destinationChannelId: FORBIDDEN_SOURCE_CHANNEL_ID,
      }),
    ];
    expect(() => collectDeletionTargets(files, "90d")).toThrow(CleanupSafetyError);
    expect(() => collectDeletionTargets(files, "90d")).toThrow(/SOURCE channel/);
  });

  it("refuses any channel that is not the expected destination", () => {
    const files = [
      receipt("slack-publication-90d-2026-08-12-cbcf3c3e.json", { destinationChannelId: "C0OTHER123" }),
    ];
    expect(() => collectDeletionTargets(files, "90d")).toThrow(/not the expected destination/);
  });

  it("re-checks the channel on every target immediately before deleting", () => {
    const smuggled = [
      { ts: OVERVIEW_TS, kind: "overview" as const, channelId: FORBIDDEN_SOURCE_CHANNEL_ID, sourceReceiptFile: "f", sourceRunId: "r" },
    ];
    expect(() => assertCleanupSafety(smuggled, "90d")).toThrow(/source channel/);
  });

  it("rejects a malformed timestamp and a target with no provenance", () => {
    const bad = { ts: OVERVIEW_TS, kind: "reply" as const, channelId: EXPECTED_DESTINATION_CHANNEL_ID, sourceReceiptFile: "", sourceRunId: "r" };
    expect(() => assertCleanupSafety([bad], "90d")).toThrow(/no publication receipt provenance/);
    expect(() =>
      assertCleanupSafety([{ ...bad, ts: "not-a-ts", sourceReceiptFile: "f" }], "90d"),
    ).toThrow(/malformed timestamp/);
  });
});

describe("arbitrary messages can never be deleted", () => {
  it("produces no targets from an empty receipt set — there is no discovery path", () => {
    expect(collectDeletionTargets([], "90d")).toEqual([]);
  });

  it("ignores a receipt with no publishedMessages and no overviewTs", () => {
    const files = [
      receipt("slack-publication-90d-2026-08-11-dddddddd.json", { overviewTs: null, publishedMessages: [] }),
    ];
    expect(collectDeletionTargets(files, "90d")).toEqual([]);
  });

  it("never reads the channel: the collector takes receipts only", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/slackCleanup/collectDeletionTargets.ts", "utf8");
    for (const forbidden of ["conversations.history", "conversations.replies", "search.messages", "WebClient"]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("exposes only chat.delete on the client", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/slackCleanup/client.ts", "utf8");
    expect(source).toMatch(/client\.chat\.delete\s*\(/);
    expect(source).not.toMatch(/client\.chat\.postMessage\s*\(/);
    expect(source).not.toMatch(/client\.conversations\./);
  });
});

describe("runDeletion", () => {
  const targets = collectDeletionTargets(
    [
      receipt("slack-publication-90d-2026-08-12-cbcf3c3e.json", {
        publishedMessages: [
          { index: 1, type: "overview", slackTs: OVERVIEW_TS, status: "success" },
          ...REPLY_TS.map((ts, i) => ({ index: i + 2, type: "issue", slackTs: ts, status: "success" as const })),
        ],
      }),
    ],
    "90d",
  );

  it("deletes replies before the parent, in order", async () => {
    const calls: string[] = [];
    const deleteFn: SlackDeleteFn = vi.fn(async ({ ts }) => {
      calls.push(ts);
      return { ok: true };
    });

    await runDeletion({ targets, windowTag: "90d", deleteFn });
    expect(calls.at(-1)).toBe(OVERVIEW_TS);
    expect(calls.slice(0, -1).sort()).toEqual([...REPLY_TS].sort());
  });

  it("sends only the hard-locked destination channel", async () => {
    const channels: string[] = [];
    const deleteFn: SlackDeleteFn = vi.fn(async ({ channel }) => {
      channels.push(channel);
      return { ok: true };
    });
    await runDeletion({ targets, windowTag: "90d", deleteFn });
    expect(new Set(channels)).toEqual(new Set([EXPECTED_DESTINATION_CHANNEL_ID]));
  });

  it("treats message_not_found as already deleted, not a failure", async () => {
    const deleteFn: SlackDeleteFn = vi.fn(async () => ({ ok: false, error: "message_not_found" }));
    const results = await runDeletion({ targets, windowTag: "90d", deleteFn });

    expect(results.every((r) => r.outcome === "already_deleted")).toBe(true);
    expect(results.some((r) => r.outcome === "failed")).toBe(false);
  });

  it("is safely rerunnable: a second pass over deleted messages reports success", async () => {
    let first = true;
    const deleteFn: SlackDeleteFn = vi.fn(async () => {
      if (first) {
        return { ok: true };
      }
      return { ok: false, error: "message_not_found" };
    });

    const firstPass = await runDeletion({ targets, windowTag: "90d", deleteFn });
    expect(firstPass.every((r) => r.outcome === "deleted")).toBe(true);

    first = false;
    const secondPass = await runDeletion({ targets, windowTag: "90d", deleteFn });
    expect(secondPass.every((r) => r.outcome === "already_deleted")).toBe(true);
  });

  it("records a genuine failure and continues with the rest", async () => {
    let call = 0;
    const deleteFn: SlackDeleteFn = vi.fn(async () => {
      call += 1;
      return call === 1 ? { ok: false, error: "cant_delete_message" } : { ok: true };
    });

    const results = await runDeletion({ targets, windowTag: "90d", deleteFn });
    expect(results[0]?.outcome).toBe("failed");
    expect(results.filter((r) => r.outcome === "deleted")).toHaveLength(targets.length - 1);
  });

  it("refuses to make any call for a 180d window", async () => {
    const deleteFn: SlackDeleteFn = vi.fn();
    await expect(runDeletion({ targets, windowTag: "180d", deleteFn })).rejects.toThrow(CleanupSafetyError);
    expect(deleteFn).not.toHaveBeenCalled();
  });
});

describe("CLI arguments require explicit confirmation", () => {
  it("defaults to preview: delete is false", () => {
    expect(parseSlackCleanupArgs([])).toEqual({ window: "90d", dryRun: false, deleteConfirmed: false });
    expect(parseSlackCleanupArgs(["--window=90d", "--dry-run"]).deleteConfirmed).toBe(false);
  });

  it("only --delete enables live deletion", () => {
    expect(parseSlackCleanupArgs(["--window=90d", "--delete"]).deleteConfirmed).toBe(true);
  });

  it("rejects a malformed window", () => {
    expect(() => parseSlackCleanupArgs(["--window=ninety"])).toThrow(/Invalid --window/);
  });

  it("makes zero Slack calls unless --delete was supplied", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/cli/intelligence-slack-cleanup.ts", "utf8");
    const guardAt = source.indexOf("if (!args.deleteConfirmed)");
    const clientAt = source.indexOf("createSlackDeleteFn(token)");
    expect(guardAt).toBeGreaterThan(-1);
    expect(clientAt).toBeGreaterThan(guardAt);
    expect(source.slice(guardAt, clientAt)).toContain("Zero Slack API calls made");
    expect(source.slice(guardAt, clientAt)).toContain("return;");
  });
});

describe("deletion receipt", () => {
  it("is written under publications with window, date, and run id", () => {
    expect(deletionReceiptFilePath("/p", "90d", new Date("2026-08-14T10:00:00.000Z"), "abc12345")).toBe(
      "/p/slack-deletion-90d-2026-08-14-abc12345.json",
    );
  });

  it("records outcome and provenance per message", async () => {
    const targets = collectDeletionTargets([receipt("slack-publication-90d-2026-08-12-cbcf3c3e.json")], "90d");
    const results = await runDeletion({
      targets,
      windowTag: "90d",
      deleteFn: vi.fn(async () => ({ ok: true })) as SlackDeleteFn,
    });

    for (const result of results) {
      expect(result.outcome).toBe("deleted");
      expect(result.sourceReceiptFile).toBe("slack-publication-90d-2026-08-12-cbcf3c3e.json");
      expect(result.ts).toMatch(/^\d+\.\d+$/);
    }
  });
});
