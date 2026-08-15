import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeGroup } from "../../src/report/analyzeGroup.js";
import { buildRecurringIssueReport } from "../../src/report/buildReport.js";
import { compareForRanking, rankGroups, RANKING_CRITERIA } from "../../src/report/rankGroups.js";
import type { GroupOutput } from "../../src/persistence/groupOutput.js";
import { parseReportArgs } from "../../src/cli/reportArgs.js";
import { reportOutputFilePath } from "../../src/persistence/reportOutput.js";
import { group, member } from "./analyzeGroup.test.js";

const ASOF = new Date("2026-08-10T00:00:00.000Z");

function analyzed(overrides: Parameters<typeof group>[0]) {
  return analyzeGroup(group(overrides), ASOF);
}

function groupOutput(groups: GroupOutput["groups"]): GroupOutput {
  return {
    metadata: {
      adjudicationInputFile: "data/intelligence/adjudications-90d-2026-08-10.json",
      extractionInputFile: "data/intelligence/extractions-90d-2026-08-09.json",
      sourceWindowDays: 90,
      createdAt: "2026-08-10T00:00:00.000Z",
      adjudicationModel: "claude-haiku-4-5",
      adjudicationPromptVersion: "v1",
      candidateSimilarityFloor: 0.6,
      adjudicatedPairs: 58,
      sameEdges: 9,
      relatedEdges: 37,
      differentEdges: 12,
      candidateComponents: 7,
      recurringGroups: groups.length,
      conflictedComponents: 0,
      overlappingGroups: 0,
      overlappingMembers: [],
      relatedPairCount: 37,
    },
    groups,
  };
}

describe("ranking", () => {
  it("orders by occurrence count first", () => {
    const three = analyzed({ groupId: "grp_a", members: [member(), member({ rootTs: "b" }), member({ rootTs: "c" })] });
    const two = analyzed({ groupId: "grp_b" });
    expect(rankGroups([two, three]).map((g) => g.groupId)).toEqual(["grp_a", "grp_b"]);
  });

  it("breaks an occurrence tie by open occurrences", () => {
    const open = analyzed({
      groupId: "grp_open",
      members: [member({ resolutionStatus: "unresolved" }), member({ rootTs: "b", resolutionStatus: "unresolved" })],
    });
    const closed = analyzed({
      groupId: "grp_closed",
      members: [member({ resolutionStatus: "resolved" }), member({ rootTs: "b", resolutionStatus: "resolved" })],
    });
    expect(rankGroups([closed, open]).map((g) => g.groupId)).toEqual(["grp_open", "grp_closed"]);
  });

  it("breaks remaining ties by peak severity", () => {
    const critical = analyzed({
      groupId: "grp_crit",
      members: [member({ severity: "critical" }), member({ rootTs: "b", severity: "low" })],
    });
    const low = analyzed({
      groupId: "grp_low",
      members: [member({ severity: "low" }), member({ rootTs: "b", severity: "low" })],
    });
    expect(rankGroups([low, critical]).map((g) => g.groupId)).toEqual(["grp_crit", "grp_low"]);
  });

  it("breaks further ties by customer impact", () => {
    const broad = analyzed({
      groupId: "grp_broad",
      members: [member({ customerImpact: "multiple_customers" }), member({ rootTs: "b" })],
    });
    const narrow = analyzed({
      groupId: "grp_narrow",
      members: [member({ customerImpact: "none" }), member({ rootTs: "b", customerImpact: "none" })],
    });
    expect(rankGroups([narrow, broad]).map((g) => g.groupId)).toEqual(["grp_broad", "grp_narrow"]);
  });

  it("breaks further ties by recency", () => {
    const recent = analyzed({ groupId: "grp_recent", lastSeen: "2026-08-01T00:00:00.000Z" });
    const older = analyzed({ groupId: "grp_older", lastSeen: "2026-06-01T00:00:00.000Z" });
    expect(rankGroups([older, recent]).map((g) => g.groupId)).toEqual(["grp_recent", "grp_older"]);
  });

  it("falls back to groupId so ordering is fully deterministic", () => {
    const first = analyzed({ groupId: "grp_aaa" });
    const second = analyzed({ groupId: "grp_bbb" });
    expect(rankGroups([second, first]).map((g) => g.groupId)).toEqual(["grp_aaa", "grp_bbb"]);
    expect(compareForRanking(first, second)).toBeLessThan(0);
  });

  it("assigns 1-based ranks and exposes the signals behind them", () => {
    const ranked = rankGroups([analyzed({ groupId: "grp_a" }), analyzed({ groupId: "grp_b" })]);
    expect(ranked.map((g) => g.rank)).toEqual([1, 2]);
    expect(ranked[0]?.rankingSignals.occurrenceCount).toBe(2);
    expect(ranked[0]?.rankingSignals).toHaveProperty("openCount");
    expect(ranked[0]?.rankingSignals).toHaveProperty("peakSeverityRank");
  });

  it("is stable across repeated runs and input orderings", () => {
    const groups = [analyzed({ groupId: "grp_a" }), analyzed({ groupId: "grp_b" }), analyzed({ groupId: "grp_c" })];
    expect(rankGroups(groups)).toEqual(rankGroups([...groups].reverse()));
  });

  it("does not mutate the input array", () => {
    const groups = [analyzed({ groupId: "grp_b" }), analyzed({ groupId: "grp_a" })];
    rankGroups(groups);
    expect(groups.map((g) => g.groupId)).toEqual(["grp_b", "grp_a"]);
  });

  it("documents its criteria for auditability", () => {
    expect(RANKING_CRITERIA.length).toBeGreaterThan(0);
    expect(RANKING_CRITERIA.join(" ")).toContain("occurrenceCount desc");
  });
});

describe("buildRecurringIssueReport", () => {
  it("summarises counts across all issues", () => {
    const report = buildRecurringIssueReport(
      groupOutput([
        group({ groupId: "grp_a", members: [member({ resolutionStatus: "unresolved" }), member({ rootTs: "b" })] }),
        group({ groupId: "grp_b" }),
      ]),
      ASOF,
    );

    expect(report.summary.recurringIssueCount).toBe(2);
    expect(report.summary.totalOccurrences).toBe(4);
    expect(report.summary.issuesWithOpenOccurrences).toBe(1);
    expect(report.summary.totalOpenOccurrences).toBe(1);
    expect(report.summary.largestGroupSize).toBe(2);
  });

  it("aggregates distributions across every occurrence", () => {
    const report = buildRecurringIssueReport(
      groupOutput([
        group({ groupId: "grp_a", members: [member({ severity: "critical" }), member({ rootTs: "b", severity: "low" })] }),
      ]),
      ASOF,
    );
    const counts = Object.fromEntries(report.summary.severityDistribution.map((e) => [e.value, e.count]));
    expect(counts.critical).toBe(1);
    expect(counts.low).toBe(1);
  });

  it("reports the overall occurrence window", () => {
    const report = buildRecurringIssueReport(
      groupOutput([
        group({ groupId: "grp_a", firstSeen: "2026-05-01T00:00:00.000Z", lastSeen: "2026-06-01T00:00:00.000Z" }),
        group({ groupId: "grp_b", firstSeen: "2026-07-01T00:00:00.000Z", lastSeen: "2026-07-20T00:00:00.000Z" }),
      ]),
      ASOF,
    );
    expect(report.summary.earliestOccurrence).toBe("2026-05-01T00:00:00.000Z");
    expect(report.summary.latestOccurrence).toBe("2026-07-20T00:00:00.000Z");
  });

  it("counts issues needing review", () => {
    const report = buildRecurringIssueReport(
      groupOutput([group({ groupId: "grp_a", consistency: "incomplete_pair_evidence" }), group({ groupId: "grp_b" })]),
      ASOF,
    );
    expect(report.summary.issuesNeedingReview).toBe(1);
  });

  it("handles an empty groups file without producing NaN", () => {
    const report = buildRecurringIssueReport(groupOutput([]), ASOF);
    expect(report.issues).toEqual([]);
    expect(report.summary.recurringIssueCount).toBe(0);
    expect(report.summary.largestGroupSize).toBe(0);
    expect(report.summary.earliestOccurrence).toBeNull();
  });

  it("is deterministic for the same input", () => {
    const input = groupOutput([group({ groupId: "grp_a" }), group({ groupId: "grp_b" })]);
    expect(buildRecurringIssueReport(input, ASOF)).toEqual(buildRecurringIssueReport(input, ASOF));
  });
});

describe("report CLI plumbing", () => {
  it("parses --input and --dry-run", () => {
    expect(parseReportArgs([])).toEqual({ input: undefined, dryRun: false });
    expect(parseReportArgs(["--input=data/intelligence/groups-90d-2026-08-10.json", "--dry-run"])).toEqual({
      input: "data/intelligence/groups-90d-2026-08-10.json",
      dryRun: true,
    });
  });

  it("names the output file with the window tag and date", () => {
    expect(reportOutputFilePath("/d", new Date("2026-08-10T09:00:00.000Z"), "90d")).toBe(
      path.join("/d", "report-90d-2026-08-10.json"),
    );
  });
});

describe("report layer has no API dependency", () => {
  const sourceFiles = [
    "src/report/analyzeGroup.ts",
    "src/report/rankGroups.ts",
    "src/report/buildReport.ts",
    "src/report/distributions.ts",
    "src/cli/intelligence-report.ts",
    "src/persistence/reportOutput.ts",
  ];

  it.each(sourceFiles)("%s makes no API call and posts nothing to Slack", async (relativePath) => {
    const source = await readFile(path.resolve(process.cwd(), relativePath), "utf8");
    for (const marker of ["@anthropic-ai/sdk", "@slack/web-api", "voyageClient", "API_KEY", "chat.postMessage"]) {
      expect(source).not.toContain(marker);
    }
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });
});
