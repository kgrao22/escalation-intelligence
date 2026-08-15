import { describe, expect, it } from "vitest";
import type { RecurringIssueGroup, RecurringIssueMember } from "../src/groups/buildGroups.js";
import type { GroupOutput } from "../src/persistence/groupOutput.js";
import {
  buildRecurringWorkflowReport,
  rankWorkflows,
  toAutomationStatusBucket,
  analyzeWorkflowGroup,
} from "../src/report/buildWorkflowReport.js";

const asOf = new Date("2026-08-20T00:00:00.000Z");

function member(overrides: Partial<RecurringIssueMember> = {}): RecurringIssueMember {
  return {
    rootTs: "1700000000.000100",
    normalizedProblemStatement: "",
    permalink: "https://slack.example/archives/C1/p1",
    postedAt: "2026-07-01T00:00:00.000Z",
    affectedSystem: "policy-admin",
    normalizedWorkflowStatement: "Support asks the technology team to manually cancel an active policy.",
    workflowClassification: "policy_cancellation",
    automationStatus: "manual",
    ...overrides,
  };
}

function group(overrides: Partial<RecurringIssueGroup> = {}): RecurringIssueGroup {
  const members = overrides.members ?? [member(), member({ rootTs: "1700000001.000100" })];
  return {
    groupId: "g1",
    name: "Manual policy cancellation",
    alternateNames: [],
    members,
    occurrenceCount: members.length,
    firstSeen: "2026-07-01T00:00:00.000Z",
    lastSeen: "2026-08-10T00:00:00.000Z",
    averageSameEdgeConfidence: 0.9,
    minimumSameEdgeConfidence: 0.85,
    averageSameEdgeSimilarity: 0.8,
    minimumSameEdgeSimilarity: 0.75,
    consistency: "fully_confirmed",
    splitFromConflictedComponent: false,
    sameEdges: [],
    relatedEdgesInsideGroup: [],
    differentEdgesInsideGroup: [],
    unadjudicatedPairsInsideGroup: [],
    ...overrides,
  };
}

function output(groups: RecurringIssueGroup[]): GroupOutput {
  return {
    metadata: {
      adjudicationInputFile: "data/intelligence/workflow-adjudications-90d-2026-08-09.json",
      extractionInputFile: "data/intelligence/extractions-90d-2026-08-09.json",
      createdAt: "2026-08-09T00:00:00.000Z",
      adjudicationModel: "claude-haiku-4-5",
      adjudicationPromptVersion: "v1",
      candidateSimilarityFloor: 0.6,
      adjudicatedPairs: 4,
      sameEdges: 2,
      relatedEdges: 1,
      differentEdges: 1,
      candidateComponents: 1,
      recurringGroups: groups.length,
      conflictedComponents: 0,
      overlappingGroups: 0,
      overlappingMembers: [],
      relatedPairCount: 1,
      category: "workflow",
    },
    groups,
  };
}

describe("toAutomationStatusBucket", () => {
  it("never guesses manual for missing or unknown values", () => {
    expect(toAutomationStatusBucket(null)).toBe("unknown");
    expect(toAutomationStatusBucket(undefined)).toBe("unknown");
    expect(toAutomationStatusBucket("scripted")).toBe("unknown");
    expect(toAutomationStatusBucket("manual")).toBe("manual");
  });
});

describe("analyzeWorkflowGroup", () => {
  it("reports the workflow statement, not the problem statement", () => {
    const analyzed = analyzeWorkflowGroup(group(), asOf);
    expect(analyzed.occurrences[0]?.normalizedWorkflowStatement).toContain("manually cancel");
  });

  it("takes the most-manual observed status as the group's posture", () => {
    const mixed = group({
      members: [member({ automationStatus: "already_automated" }), member({ automationStatus: "manual" })],
    });
    expect(analyzeWorkflowGroup(mixed, asOf).predominantAutomationStatus).toBe("manual");
  });

  it("computes the recurrence window and gap", () => {
    const analyzed = analyzeWorkflowGroup(group(), asOf);
    expect(analyzed.spanDays).toBe(40);
    expect(analyzed.averageDaysBetweenOccurrences).toBe(40);
    expect(analyzed.daysSinceLastOccurrence).toBe(10);
  });

  it("preserves Slack evidence links", () => {
    expect(analyzeWorkflowGroup(group(), asOf).occurrences.every((o) => o.permalink !== null)).toBe(true);
  });
});

describe("rankWorkflows", () => {
  it("ranks by frequency first", () => {
    const ranked = rankWorkflows([
      analyzeWorkflowGroup(group({ groupId: "small", members: [member()] }), asOf),
      analyzeWorkflowGroup(group({ groupId: "big", members: [member(), member(), member()] }), asOf),
    ]);
    expect(ranked.map((w) => w.groupId)).toEqual(["big", "small"]);
  });

  it("prefers still-manual workflows at equal frequency", () => {
    const ranked = rankWorkflows([
      analyzeWorkflowGroup(
        group({ groupId: "auto", members: [member({ automationStatus: "already_automated" })] }),
        asOf,
      ),
      analyzeWorkflowGroup(group({ groupId: "manual", members: [member({ automationStatus: "manual" })] }), asOf),
    ]);
    expect(ranked.map((w) => w.groupId)).toEqual(["manual", "auto"]);
  });
});

describe("buildRecurringWorkflowReport", () => {
  it("summarises workflow recurrence in its own model", () => {
    const report = buildRecurringWorkflowReport(output([group()]), asOf);
    expect(report.summary.recurringWorkflowCount).toBe(1);
    expect(report.summary.totalOccurrences).toBe(2);
    expect(report.summary.fullyManualWorkflowCount).toBe(1);
    expect(report.workflows).toHaveLength(1);
  });

  it("exposes no field that could be summed with technical defect counts", () => {
    const report = buildRecurringWorkflowReport(output([group()]), asOf);
    expect(report.summary).not.toHaveProperty("recurringIssueCount");
    expect(report).not.toHaveProperty("issues");
  });

  it("is deterministic", () => {
    const a = buildRecurringWorkflowReport(output([group()]), asOf);
    const b = buildRecurringWorkflowReport(output([group()]), asOf);
    expect(a).toEqual(b);
  });

  it("handles an empty groups file", () => {
    const report = buildRecurringWorkflowReport(output([]), asOf);
    expect(report.summary.recurringWorkflowCount).toBe(0);
    expect(report.summary.earliestOccurrence).toBeNull();
  });
});
