import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import type { IssueRecommendationLLMOutput } from "../../src/llm/schemas/issueRecommendation.js";
import { parseRecommendArgs } from "../../src/cli/recommendArgs.js";
import {
  buildPriorRecommendationIndex,
  countRecommendations,
  lookupPriorRecommendation,
  recommendationOutputFilePath,
  type RecommendationOutput,
  type RecommendationResultItem,
} from "../../src/persistence/recommendationOutput.js";
import {
  RecommendationParseError,
  RecommendationRefusedError,
  recommendIssue,
  type RecommendationParseFn,
} from "../../src/recommendations/recommendIssue.js";
import { limitIssues, runRecommendations } from "../../src/recommendations/runRecommendations.js";
import { analyzeGroup } from "../../src/report/analyzeGroup.js";
import { rankGroups } from "../../src/report/rankGroups.js";
import { group, member } from "../report/analyzeGroup.test.js";

const ASOF = new Date("2026-08-10T00:00:00.000Z");
const noSleep = () => Promise.resolve();

const verdict: IssueRecommendationLLMOutput = {
  recommendedAction: "monitor_only",
  priority: "low",
  engineeringRecommendation: "Watch for regression.",
  rationale: "Already fixed.",
  evidenceSummary: "Both occurrences resolved.",
  automationOpportunity: "not_applicable",
  automationIdea: null,
  confidence: 0.9,
};

function issue(groupId: string, overrides: Parameters<typeof group>[0] = {}) {
  return rankGroups([analyzeGroup(group({ groupId, ...overrides }), ASOF)])[0]!;
}

function parseFnReturning(
  output: IssueRecommendationLLMOutput | null,
  stopReason = "end_turn",
): RecommendationParseFn {
  return vi.fn(async () => ({ parsed_output: output, stop_reason: stopReason }));
}

describe("recommendIssue", () => {
  it("attaches the groupId locally rather than trusting the model", async () => {
    const result = await recommendIssue(parseFnReturning(verdict), "claude-haiku-4-5", issue("grp_a"));
    expect(result.groupId).toBe("grp_a");
    expect(result.recommendedAction).toBe("monitor_only");
  });

  it("sends the recommendation system prompt and requested model", async () => {
    const parseFn = parseFnReturning(verdict);
    await recommendIssue(parseFn, "claude-sonnet-5", issue("grp_a"));

    const call = vi.mocked(parseFn).mock.calls[0]?.[0];
    expect(call?.model).toBe("claude-sonnet-5");
    expect(call?.systemPrompt).toContain("ALREADY been confirmed as recurring");
  });

  it("enforces the automation-idea invariant on the response", async () => {
    const parseFn = parseFnReturning({
      ...verdict,
      automationOpportunity: "not_applicable",
      automationIdea: "Should be stripped",
    });
    const result = await recommendIssue(parseFn, "claude-haiku-4-5", issue("grp_a"));
    expect(result.automationIdea).toBeNull();
  });

  it("throws on a malformed response and does not retry it", async () => {
    const parseFn = parseFnReturning(null, "max_tokens");
    await expect(recommendIssue(parseFn, "claude-haiku-4-5", issue("grp_a"), undefined, noSleep)).rejects.toThrow(
      RecommendationParseError,
    );
    expect(parseFn).toHaveBeenCalledTimes(1);
  });

  it("throws on a refusal", async () => {
    await expect(
      recommendIssue(parseFnReturning(null, "refusal"), "claude-haiku-4-5", issue("grp_a")),
    ).rejects.toThrow(RecommendationRefusedError);
  });

  it("retries a rate limit within the bound then succeeds", async () => {
    let calls = 0;
    const parseFn: RecommendationParseFn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        throw new Anthropic.RateLimitError(
          429,
          { error: { type: "rate_limit_error", message: "slow" } },
          "slow",
          new Headers(),
        );
      }
      return { parsed_output: verdict, stop_reason: "end_turn" };
    });

    const result = await recommendIssue(
      parseFn,
      "claude-haiku-4-5",
      issue("grp_a"),
      { maxAttempts: 3, baseDelayMs: 1 },
      noSleep,
    );
    expect(result.priority).toBe("low");
    expect(parseFn).toHaveBeenCalledTimes(3);
  });

  it("stops after the bounded attempts rather than retrying forever", async () => {
    const parseFn: RecommendationParseFn = vi.fn(async () => {
      throw new Anthropic.RateLimitError(
        429,
        { error: { type: "rate_limit_error", message: "slow" } },
        "slow",
        new Headers(),
      );
    });

    await expect(
      recommendIssue(parseFn, "claude-haiku-4-5", issue("grp_a"), { maxAttempts: 3, baseDelayMs: 1 }, noSleep),
    ).rejects.toThrow();
    expect(parseFn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-retryable error", async () => {
    const parseFn: RecommendationParseFn = vi.fn(async () => {
      throw new Anthropic.BadRequestError(
        400,
        { error: { type: "invalid_request_error", message: "bad" } },
        "bad",
        new Headers(),
      );
    });

    await expect(
      recommendIssue(parseFn, "claude-haiku-4-5", issue("grp_a"), { maxAttempts: 3, baseDelayMs: 1 }, noSleep),
    ).rejects.toThrow(Anthropic.BadRequestError);
    expect(parseFn).toHaveBeenCalledTimes(1);
  });
});

describe("limitIssues", () => {
  const issues = [issue("grp_a"), issue("grp_b"), issue("grp_c")];

  it("returns everything without a limit", () => {
    expect(limitIssues(issues)).toHaveLength(3);
  });

  it("slices to the first N", () => {
    expect(limitIssues(issues, 2).map((i) => i.groupId)).toEqual(["grp_a", "grp_b"]);
  });
});

describe("runRecommendations", () => {
  it("makes exactly one call per recurring issue", async () => {
    const parseFn = parseFnReturning(verdict);
    await runRecommendations({
      issues: [issue("grp_a"), issue("grp_b"), issue("grp_c")],
      parseFn,
      model: "claude-haiku-4-5",
      promptVersion: "v1",
      priorIndex: new Map(),
    });
    expect(parseFn).toHaveBeenCalledTimes(3);
  });

  it("retains permalinks on results for later rendering", async () => {
    const { results } = await runRecommendations({
      issues: [issue("grp_a")],
      parseFn: parseFnReturning(verdict),
      model: "claude-haiku-4-5",
      promptVersion: "v1",
      priorIndex: new Map(),
    });
    expect(results[0]?.permalinks).toHaveLength(2);
    expect(results[0]?.permalinks[0]?.permalink).toBe("https://slack/a");
  });

  it("reuses a cached recommendation without calling the LLM", async () => {
    const parseFn = parseFnReturning(verdict);
    const cached: RecommendationResultItem = {
      groupId: "grp_a",
      name: "Test issue",
      occurrenceCount: 2,
      permalinks: [],
      status: "success",
      recommendedAction: "permanent_code_fix",
      priority: "high",
      engineeringRecommendation: "cached",
      rationale: "cached",
      evidenceSummary: "cached",
      automationOpportunity: "low",
      automationIdea: null,
      confidence: 0.7,
    };

    const { results } = await runRecommendations({
      issues: [issue("grp_a")],
      parseFn,
      model: "claude-haiku-4-5",
      promptVersion: "v1",
      priorIndex: new Map([["grp_a::v1::claude-haiku-4-5", cached]]),
    });

    expect(parseFn).not.toHaveBeenCalled();
    expect(results).toEqual([cached]);
  });

  it("does not reuse across a different prompt version or model", async () => {
    const parseFn = parseFnReturning(verdict);
    const cached = { groupId: "grp_a", status: "success" } as RecommendationResultItem;

    await runRecommendations({
      issues: [issue("grp_a")],
      parseFn,
      model: "claude-haiku-4-5",
      promptVersion: "v2",
      priorIndex: new Map([["grp_a::v1::claude-haiku-4-5", cached]]),
    });
    expect(parseFn).toHaveBeenCalledTimes(1);
  });

  it("records a failure and continues with the remaining issues", async () => {
    let call = 0;
    const parseFn: RecommendationParseFn = vi.fn(async () => {
      call += 1;
      if (call === 2) {
        throw new Error("boom");
      }
      return { parsed_output: verdict, stop_reason: "end_turn" };
    });

    const { results } = await runRecommendations({
      issues: [issue("grp_a"), issue("grp_b"), issue("grp_c")],
      parseFn,
      model: "claude-haiku-4-5",
      promptVersion: "v1",
      priorIndex: new Map(),
      sleep: noSleep,
    });

    expect(results).toHaveLength(3);
    expect(results[1]?.status).toBe("failed");
    expect(results[2]?.status).toBe("success");
  });

  it("accumulates redaction counts across issues", async () => {
    const { redactionsApplied } = await runRecommendations({
      issues: [
        issue("grp_a", { members: [member({ suspectedRootCause: "a@b.com" }), member({ rootTs: "b" })] }),
        issue("grp_b", { members: [member({ suspectedRootCause: "c@d.com" }), member({ rootTs: "b" })] }),
      ],
      parseFn: parseFnReturning(verdict),
      model: "claude-haiku-4-5",
      promptVersion: "v1",
      priorIndex: new Map(),
    });
    expect(redactionsApplied).toBe(2);
  });
});

describe("recommendation persistence", () => {
  it("counts actions, priorities, and automation opportunities", () => {
    const counts = countRecommendations([
      { groupId: "a", name: null, occurrenceCount: 2, permalinks: [], status: "success", recommendedAction: "monitor_only", priority: "low", automationOpportunity: "not_applicable" },
      { groupId: "b", name: null, occurrenceCount: 2, permalinks: [], status: "success", recommendedAction: "monitor_only", priority: "high", automationOpportunity: "high" },
      { groupId: "c", name: null, occurrenceCount: 2, permalinks: [], status: "failed", error: "boom" },
    ]);

    expect(counts.actionCounts.monitor_only).toBe(2);
    expect(counts.priorityCounts.low).toBe(1);
    expect(counts.priorityCounts.high).toBe(1);
    expect(counts.automationOpportunityCounts.not_applicable).toBe(1);
    expect(counts.actionCounts.permanent_code_fix).toBe(0);
  });

  it("indexes only successes for reuse", () => {
    const output = {
      metadata: { promptVersion: "v1", model: "claude-haiku-4-5" },
      results: [
        { groupId: "a", status: "success" },
        { groupId: "b", status: "failed" },
      ],
    } as unknown as RecommendationOutput;

    const index = buildPriorRecommendationIndex([output]);
    expect(lookupPriorRecommendation(index, "a", "v1", "claude-haiku-4-5")).toBeDefined();
    expect(lookupPriorRecommendation(index, "b", "v1", "claude-haiku-4-5")).toBeUndefined();
  });

  it("names the output file with window tag and date", () => {
    expect(recommendationOutputFilePath("/d", new Date("2026-08-11T09:00:00.000Z"), "90d")).toBe(
      path.join("/d", "recommendations-90d-2026-08-11.json"),
    );
  });
});

describe("parseRecommendArgs", () => {
  it("defaults to auto input, no limit, no model override", () => {
    expect(parseRecommendArgs([])).toEqual({ input: undefined, limit: undefined, model: undefined, dryRun: false });
  });

  it("parses --input, --limit, --model and --dry-run", () => {
    expect(
      parseRecommendArgs([
        "--input=data/intelligence/report-90d-2026-08-10.json",
        "--limit=3",
        "--model=claude-sonnet-5",
        "--dry-run",
      ]),
    ).toEqual({
      input: "data/intelligence/report-90d-2026-08-10.json",
      limit: 3,
      model: "claude-sonnet-5",
      dryRun: true,
    });
  });

  it("rejects an invalid --limit", () => {
    expect(() => parseRecommendArgs(["--limit=abc"])).toThrow(/Invalid --limit value/);
    expect(() => parseRecommendArgs(["--limit=0"])).toThrow(/Invalid --limit value/);
  });
});

describe("recommendation layer sends no raw Slack content", () => {
  it("builds payloads with no Slack or identifier fields", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src/recommendations/buildPayload.ts"), "utf8");
    expect(source).not.toContain("@slack/web-api");
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });

  it("never posts to Slack from the CLI", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src/cli/intelligence-recommend.ts"), "utf8");
    expect(source).not.toContain("chat.postMessage");
    expect(source).not.toContain("@slack/web-api");
  });
});

/**
 * The recommendation cache key is (groupId + promptVersion + model). A group id
 * is a hash of its member rootTs set, so the SAME id legitimately recurs across
 * windows whose underlying problem statements differ — the 180-day run served 4
 * recommendations from the 90-day file this way. Reuse is therefore scoped by
 * report provenance in the CLI, which these tests pin down.
 */
describe("recommendation cache provenance isolation", () => {
  const REPORT_180 = "data/intelligence/report-180d-2026-08-14.json";
  const REPORT_90 = "data/intelligence/report-90d-2026-08-11.json";

  function outputFrom(reportInputFile: string, groupIds: string[]): RecommendationOutput {
    return {
      metadata: { reportInputFile, promptVersion: "v1", model: "claude-haiku-4-5" },
      results: groupIds.map((groupId) => ({ groupId, status: "success" })),
    } as unknown as RecommendationOutput;
  }

  /** Mirrors the filter the CLI applies before building the index. */
  function scopeToReport(outputs: RecommendationOutput[], reportInputFile: string): RecommendationOutput[] {
    return outputs.filter((output) => output.metadata.reportInputFile === reportInputFile);
  }

  it("does NOT reuse a verdict for the same group id from a different report", () => {
    const priors = [outputFrom(REPORT_90, ["grp_0f9393f95d3b"])];
    const index = buildPriorRecommendationIndex(scopeToReport(priors, REPORT_180));
    expect(lookupPriorRecommendation(index, "grp_0f9393f95d3b", "v1", "claude-haiku-4-5")).toBeUndefined();
  });

  it("DOES reuse a verdict from the same report artifact", () => {
    const priors = [outputFrom(REPORT_180, ["grp_0f9393f95d3b"])];
    const index = buildPriorRecommendationIndex(scopeToReport(priors, REPORT_180));
    expect(lookupPriorRecommendation(index, "grp_0f9393f95d3b", "v1", "claude-haiku-4-5")).toBeDefined();
  });

  it("cannot be contaminated by a 90-day file during a 180-day run", () => {
    // The four real group ids that leaked across windows in the first run.
    const leaked = ["grp_0f9393f95d3b", "grp_ba49eb871bf5", "grp_18a64792106f", "grp_388ae6cdfa8b"];
    const priors = [outputFrom(REPORT_90, leaked)];
    const index = buildPriorRecommendationIndex(scopeToReport(priors, REPORT_180));

    for (const groupId of leaked) {
      expect(lookupPriorRecommendation(index, groupId, "v1", "claude-haiku-4-5")).toBeUndefined();
    }
    expect(index.size).toBe(0);
  });

  it("keeps resumability working across repeated runs over the exact same report", () => {
    const firstRun = outputFrom(REPORT_180, ["grp_a", "grp_b"]);
    const index = buildPriorRecommendationIndex(scopeToReport([firstRun], REPORT_180));
    expect(lookupPriorRecommendation(index, "grp_a", "v1", "claude-haiku-4-5")).toBeDefined();
    expect(lookupPriorRecommendation(index, "grp_b", "v1", "claude-haiku-4-5")).toBeDefined();
  });

  it("still refuses reuse across prompt version or model within one report", () => {
    const index = buildPriorRecommendationIndex(scopeToReport([outputFrom(REPORT_180, ["grp_a"])], REPORT_180));
    expect(lookupPriorRecommendation(index, "grp_a", "v2", "claude-haiku-4-5")).toBeUndefined();
    expect(lookupPriorRecommendation(index, "grp_a", "v1", "claude-sonnet-5")).toBeUndefined();
  });

  it("filters by report provenance in the CLI before indexing", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/cli/intelligence-recommend.ts", "utf8");
    expect(source).toContain("output.metadata.reportInputFile === reportInput.relativePath");
    const filterAt = source.indexOf("output.metadata.reportInputFile === reportInput.relativePath");
    const indexAt = source.indexOf("buildPriorRecommendationIndex(priorOutputs)");
    expect(filterAt).toBeGreaterThan(-1);
    expect(indexAt).toBeGreaterThan(filterAt);
  });
});
