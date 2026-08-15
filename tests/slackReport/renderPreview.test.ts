import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSlackPreviewArgs } from "../../src/cli/slackPreviewArgs.js";
import type { RecommendationOutput, RecommendationResultItem } from "../../src/persistence/recommendationOutput.js";
import type { ReportOutput } from "../../src/persistence/reportOutput.js";
import { slackPreviewOutputFilePath } from "../../src/persistence/slackPreviewOutput.js";
import { analyzeGroup } from "../../src/report/analyzeGroup.js";
import { rankGroups } from "../../src/report/rankGroups.js";
import {
  joinReportAndRecommendations,
  PreviewJoinError,
  renderSlackReportPreview,
} from "../../src/slackReport/renderPreview.js";
import { group, member } from "../report/analyzeGroup.test.js";

const ASOF = new Date("2026-08-11T00:00:00.000Z");

function reportOutput(groupOverrides: Array<Parameters<typeof group>[0]>): ReportOutput {
  const issues = rankGroups(groupOverrides.map((o) => analyzeGroup(group(o), ASOF)));
  return {
    metadata: {
      groupsInputFile: "data/intelligence/groups-90d-2026-08-10.json",
      createdAt: ASOF.toISOString(),
      asOf: ASOF.toISOString(),
      sourceWindowDays: 90,
      adjudicationModel: "claude-haiku-4-5",
      adjudicationPromptVersion: "v1",
      candidateSimilarityFloor: 0.6,
    },
    report: {
      summary: {
        recurringIssueCount: issues.length,
        totalOccurrences: issues.reduce((s, i) => s + i.occurrenceCount, 0),
        issuesWithOpenOccurrences: 0,
        totalOpenOccurrences: 0,
        issuesNeedingReview: 0,
        largestGroupSize: 0,
        severityDistribution: [],
        customerImpactDistribution: [],
        resolutionStatusDistribution: [],
        earliestOccurrence: null,
        latestOccurrence: null,
      },
      rankingCriteria: [],
      issues,
    },
  };
}

function recommendation(
  groupId: string,
  overrides: Partial<RecommendationResultItem> = {},
): RecommendationResultItem {
  return {
    groupId,
    name: "Test issue",
    occurrenceCount: 2,
    permalinks: [],
    status: "success",
    recommendedAction: "permanent_code_fix",
    priority: "high",
    engineeringRecommendation: "Fix the calculation.",
    rationale: "Deterministic defect.",
    evidenceSummary: "Two occurrences with the same mechanism.",
    automationOpportunity: "high",
    automationIdea: "Add a reconciliation job.",
    confidence: 0.92,
    ...overrides,
  };
}

function recommendationsOutput(results: RecommendationResultItem[]): RecommendationOutput {
  return {
    metadata: {
      reportInputFile: "data/intelligence/report-90d-2026-08-11.json",
      createdAt: ASOF.toISOString(),
      model: "claude-haiku-4-5",
      promptVersion: "v1",
      sourceWindowDays: 90,
      recurringIssuesAvailable: results.length,
      analysed: results.length,
      failures: 0,
      actionCounts: {} as never,
      priorityCounts: {} as never,
      automationOpportunityCounts: {} as never,
      redactionsApplied: 0,
    },
    results,
  };
}

describe("joinReportAndRecommendations", () => {
  it("joins by groupId in report rank order", () => {
    const report = reportOutput([{ groupId: "grp_a" }, { groupId: "grp_b" }]);
    const recs = recommendationsOutput([recommendation("grp_b"), recommendation("grp_a")]);

    const { joined } = joinReportAndRecommendations(report, recs);
    expect(joined.map((entry) => entry.issue.groupId)).toEqual(["grp_a", "grp_b"]);
  });

  it("fails when a recommendation references an unknown groupId", () => {
    const report = reportOutput([{ groupId: "grp_a" }]);
    const recs = recommendationsOutput([recommendation("grp_missing")]);

    expect(() => joinReportAndRecommendations(report, recs)).toThrow(PreviewJoinError);
    expect(() => joinReportAndRecommendations(report, recs)).toThrow(/not in the report/);
  });

  it("fails on duplicate groupIds in the recommendations", () => {
    const report = reportOutput([{ groupId: "grp_a" }]);
    const recs = recommendationsOutput([recommendation("grp_a"), recommendation("grp_a")]);

    expect(() => joinReportAndRecommendations(report, recs)).toThrow(/Duplicate groupIds/);
  });

  it("fails when a successful recommendation is missing a required field", () => {
    const report = reportOutput([{ groupId: "grp_a" }]);
    const recs = recommendationsOutput([recommendation("grp_a", { engineeringRecommendation: undefined })]);

    expect(() => joinReportAndRecommendations(report, recs)).toThrow(/missing required field/);
  });

  it("fails when confidence is missing", () => {
    const report = reportOutput([{ groupId: "grp_a" }]);
    const recs = recommendationsOutput([recommendation("grp_a", { confidence: undefined })]);

    expect(() => joinReportAndRecommendations(report, recs)).toThrow(/confidence/);
  });

  it("omits issues whose recommendation failed rather than rendering a blank section", () => {
    const report = reportOutput([{ groupId: "grp_a" }, { groupId: "grp_b" }]);
    const recs = recommendationsOutput([
      recommendation("grp_a"),
      { groupId: "grp_b", name: null, occurrenceCount: 2, permalinks: [], status: "failed", error: "boom" },
    ]);

    const { joined, omittedGroupIds } = joinReportAndRecommendations(report, recs);
    expect(joined).toHaveLength(1);
    expect(omittedGroupIds).toEqual(["grp_b"]);
  });
});

describe("renderSlackReportPreview — overview", () => {
  const report = reportOutput([
    {
      groupId: "grp_a",
      name: "Record archival state sync failure",
      members: [member({ resolutionStatus: "workaround" }), member({ rootTs: "b", resolutionStatus: "workaround" })],
    },
    { groupId: "grp_b", name: "Invoice tax calculation omits fee components" },
  ]);
  const recs = recommendationsOutput([
    recommendation("grp_a", { automationOpportunity: "high" }),
    recommendation("grp_b", { priority: "low", automationOpportunity: "not_applicable", automationIdea: null }),
  ]);

  it("includes the analysis window and headline metrics", () => {
    const { overview } = renderSlackReportPreview(report, recs);
    expect(overview.text).toContain("*Escalation Intelligence — 90 Day Review*");
    expect(overview.text).toContain("Analysed 90 days of the escalations channel.");
    expect(overview.text).toContain("2 confirmed recurring issue patterns");
    expect(overview.text).toContain("4 occurrences across those patterns");
    expect(overview.text).toContain("1 recurring issue still have open/workaround occurrences");
    expect(overview.text).toContain("1 high automation opportunity");
  });

  it("includes the technical escalation count only when supplied", () => {
    expect(renderSlackReportPreview(report, recs).overview.text).not.toContain("technical escalations identified");
    expect(
      renderSlackReportPreview(report, recs, { totalTechnicalEscalations: 70 }).overview.text,
    ).toContain("70 technical escalations identified");
  });

  it("renders a compact ranked list, passing names through when no short form is configured", () => {
    const { overview } = renderSlackReportPreview(report, recs);
    expect(overview.text).toContain("1. 🔴 Record archival state sync failure — 2 occurrences");
    expect(overview.text).toContain("2. 🟢 Invoice tax calculation omits fee components — 2 occurrences");
  });

  it("does not include full recommendations in the overview", () => {
    const { overview } = renderSlackReportPreview(report, recs);
    expect(overview.text).not.toContain("Fix the calculation.");
    expect(overview.text).not.toContain("Confidence:");
  });

  it("reports an accurate character count", () => {
    const { overview } = renderSlackReportPreview(report, recs);
    expect(overview.characterCount).toBe(overview.text.length);
  });
});

describe("renderSlackReportPreview — issue detail", () => {
  const baseReport = reportOutput([
    {
      groupId: "grp_a",
      name: "Invoice tax calculation omits fee components",
      members: [
        member({ permalink: "https://slack.example/p1", resolutionStatus: "workaround" }),
        member({ rootTs: "b", permalink: "https://slack.example/p2", resolutionStatus: "unresolved" }),
      ],
    },
  ]);

  it("renders the header, counts, priority, and automation together", () => {
    const preview = renderSlackReportPreview(baseReport, recommendationsOutput([recommendation("grp_a")]));
    const text = preview.issues[0]!.text;

    expect(text).toContain("*1. Invoice tax calculation omits fee components* 🔴");
    expect(text).toContain("2 occurrences · High priority · Automation: High");
  });

  it("renders the recurrence window and compact status", () => {
    const preview = renderSlackReportPreview(baseReport, recommendationsOutput([recommendation("grp_a")]));
    expect(preview.issues[0]!.text).toContain("Jun 1 → Jul 1 · Open: 1 unresolved, 1 workaround");
  });

  it("renders pattern and recommended action sections", () => {
    const preview = renderSlackReportPreview(baseReport, recommendationsOutput([recommendation("grp_a")]));
    const text = preview.issues[0]!.text;
    expect(text).toContain("*Pattern*\nTwo occurrences with the same mechanism.");
    expect(text).toContain("*Recommended action*\nFix the calculation.");
  });

  it("includes the automation idea for high opportunity", () => {
    const preview = renderSlackReportPreview(baseReport, recommendationsOutput([recommendation("grp_a")]));
    expect(preview.issues[0]!.text).toContain("*Automation opportunity*\nAdd a reconciliation job.");
  });

  it("includes the automation idea for medium opportunity", () => {
    const preview = renderSlackReportPreview(
      baseReport,
      recommendationsOutput([recommendation("grp_a", { automationOpportunity: "medium" })]),
    );
    expect(preview.issues[0]!.text).toContain("*Automation opportunity*");
  });

  it("omits the automation idea for low and not applicable", () => {
    for (const automationOpportunity of ["low", "not_applicable"] as const) {
      const preview = renderSlackReportPreview(
        baseReport,
        recommendationsOutput([recommendation("grp_a", { automationOpportunity })]),
      );
      expect(preview.issues[0]!.text).not.toContain("*Automation opportunity*");
    }
  });

  it("renders Slack mrkdwn evidence links", () => {
    const preview = renderSlackReportPreview(baseReport, recommendationsOutput([recommendation("grp_a")]));
    expect(preview.issues[0]!.text).toContain(
      "<https://slack.example/p1|Occurrence 1> · <https://slack.example/p2|Occurrence 2>",
    );
  });

  it("never renders rootTs values", () => {
    const preview = renderSlackReportPreview(baseReport, recommendationsOutput([recommendation("grp_a")]));
    const text = preview.issues[0]!.text;
    expect(text).not.toContain("1781246131");
    expect(text).not.toContain("rootTs");
  });

  it("never renders internal identifiers or model details", () => {
    const preview = renderSlackReportPreview(baseReport, recommendationsOutput([recommendation("grp_a")]));
    const text = preview.issues[0]!.text;
    expect(text).not.toContain("grp_");
    expect(text).not.toContain("claude-haiku");
    expect(text).not.toContain("similarity");
    expect(text).not.toContain("Deterministic defect.");
  });

  it("renders confidence, with a warning below 0.80", () => {
    const high = renderSlackReportPreview(baseReport, recommendationsOutput([recommendation("grp_a")]));
    expect(high.issues[0]!.text).toContain("Confidence: 92%");
    expect(high.issues[0]!.text).not.toContain("⚠️");

    const low = renderSlackReportPreview(
      baseReport,
      recommendationsOutput([recommendation("grp_a", { confidence: 0.72 })]),
    );
    expect(low.issues[0]!.text).toContain("Confidence: 72% ⚠️");
  });

  it("carries the groupId in the preview model but not in the text", () => {
    const preview = renderSlackReportPreview(baseReport, recommendationsOutput([recommendation("grp_a")]));
    expect(preview.issues[0]!.groupId).toBe("grp_a");
    expect(preview.issues[0]!.text).not.toContain("grp_a");
  });
});

describe("renderSlackReportPreview — structure", () => {
  it("produces one overview plus one message per issue, in rank order", () => {
    const report = reportOutput([{ groupId: "grp_a" }, { groupId: "grp_b" }, { groupId: "grp_c" }]);
    const recs = recommendationsOutput([
      recommendation("grp_a"),
      recommendation("grp_b"),
      recommendation("grp_c"),
    ]);

    const preview = renderSlackReportPreview(report, recs);
    expect(preview.issues).toHaveLength(3);
    expect(preview.issues.map((m) => m.groupId)).toEqual(["grp_a", "grp_b", "grp_c"]);
  });

  it("numbers detail messages consistently with the overview ranking", () => {
    const report = reportOutput([{ groupId: "grp_a" }, { groupId: "grp_b" }]);
    const recs = recommendationsOutput([recommendation("grp_a"), recommendation("grp_b")]);
    const preview = renderSlackReportPreview(report, recs);

    expect(preview.issues[0]!.text.startsWith("*1. ")).toBe(true);
    expect(preview.issues[1]!.text.startsWith("*2. ")).toBe(true);
  });

  it("reports accurate character counts on every message", () => {
    const report = reportOutput([{ groupId: "grp_a" }]);
    const preview = renderSlackReportPreview(report, recommendationsOutput([recommendation("grp_a")]));
    for (const message of [preview.overview, ...preview.issues]) {
      expect(message.characterCount).toBe(message.text.length);
    }
  });

  it("keeps messages within a readable Slack size", () => {
    const report = reportOutput([{ groupId: "grp_a" }]);
    const preview = renderSlackReportPreview(report, recommendationsOutput([recommendation("grp_a")]));
    for (const message of [preview.overview, ...preview.issues]) {
      expect(message.characterCount).toBeLessThan(3000);
    }
  });

  it("is deterministic for the same input", () => {
    const report = reportOutput([{ groupId: "grp_a" }]);
    const recs = recommendationsOutput([recommendation("grp_a")]);
    expect(renderSlackReportPreview(report, recs)).toEqual(renderSlackReportPreview(report, recs));
  });
});

describe("preview CLI plumbing", () => {
  it("parses explicit inputs", () => {
    expect(
      parseSlackPreviewArgs([
        "--report=data/intelligence/report-90d-2026-08-11.json",
        "--recommendations=data/intelligence/recommendations-90d-2026-08-11.json",
      ]),
    ).toEqual({
      report: "data/intelligence/report-90d-2026-08-11.json",
      recommendations: "data/intelligence/recommendations-90d-2026-08-11.json",
      totalEscalations: undefined,
    });
  });

  it("parses --total-escalations and rejects invalid values", () => {
    expect(parseSlackPreviewArgs(["--total-escalations=70"]).totalEscalations).toBe(70);
    expect(() => parseSlackPreviewArgs(["--total-escalations=abc"])).toThrow(/Invalid --total-escalations/);
  });

  it("names the preview artifact with window tag and date", () => {
    expect(slackPreviewOutputFilePath("/d", new Date("2026-08-11T09:00:00.000Z"), "90d")).toBe(
      path.join("/d", "slack-preview-90d-2026-08-11.json"),
    );
  });
});

describe("preview layer posts nothing and has no Slack SDK dependency", () => {
  const sourceFiles = [
    "src/slackReport/renderPreview.ts",
    "src/slackReport/formatters.ts",
    "src/slackReport/displayNames.ts",
    "src/cli/intelligence-slack-preview.ts",
    "src/cli/slackPreviewArgs.ts",
    "src/persistence/slackPreviewOutput.ts",
  ];

  it.each(sourceFiles)("%s imports no Slack SDK and performs no write call", async (relativePath) => {
    const source = await readFile(path.resolve(process.cwd(), relativePath), "utf8");
    for (const marker of [
      "@slack/web-api",
      "chat.postMessage",
      "chat:write",
      "WebClient",
      "@anthropic-ai/sdk",
      "voyageClient",
    ]) {
      expect(source).not.toContain(marker);
    }
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });

  it("keeps posted false in the persisted artifact type", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src/persistence/slackPreviewOutput.ts"), "utf8");
    expect(source).toContain("posted: false");
  });
});
