import { describe, expect, it } from "vitest";
import { buildRecurringIssueGroups, groupIdFor, selectGroupName } from "../../src/groups/buildGroups.js";
import { memberPairKey } from "../../src/groups/relationshipMatrix.js";
import type { Relationship } from "../../src/llm/schemas/recurrenceAdjudication.js";
import type { EscalationAnalysis } from "../../src/llm/schemas/escalationAnalysis.js";
import type { AdjudicationResultItem } from "../../src/persistence/adjudicationOutput.js";

/** Real Slack ts values so postedAt derivation is exercised. */
const TS = {
  A: "1781246131.192699",
  B: "1783049403.116279",
  C: "1784691264.089819",
  D: "1785405604.748049",
};

function edge(
  a: string,
  b: string,
  relationship: Relationship,
  overrides: Partial<AdjudicationResultItem> = {},
): AdjudicationResultItem {
  return {
    pairId: memberPairKey(a, b),
    similarity: 0.8,
    a: { rootTs: a, normalizedProblemStatement: `statement ${a}`, permalink: `https://slack/${a}` },
    b: { rootTs: b, normalizedProblemStatement: `statement ${b}`, permalink: `https://slack/${b}` },
    status: "success",
    relationship,
    confidence: 0.9,
    reasoning: "because",
    proposedRecurringIssueName: relationship === "same_underlying_issue" ? `Issue ${a}-${b}` : null,
    ...overrides,
  };
}

function analysis(rootTs: string, overrides: Partial<EscalationAnalysis> = {}): EscalationAnalysis {
  return {
    rootTs,
    permalink: `https://slack/${rootTs}`,
    isTechnicalEscalation: true,
    classification: "technical_defect",
    normalizedProblemStatement: `extracted statement ${rootTs}`,
    affectedSystem: "billing",
    issueTypeHint: "sync",
    severity: "high",
    customerImpact: "multiple_customers",
    suspectedRootCause: `cause ${rootTs}`,
    rootCauseConfidence: 0.7,
    resolutionStatus: "resolved",
    resolutionSummary: `resolution ${rootTs}`,
    isRecurringEvidenceInThread: true,
    automationCandidate: "permanent_code_fix",
    automationReasoning: null,
    isAutomationWorkflowCandidate: false,
    workflowClassification: null,
    normalizedWorkflowStatement: null,
    automationStatus: "unknown",
    confidence: 0.9,
    ...overrides,
  };
}

const emptyIndex = new Map<string, EscalationAnalysis>();

describe("groupIdFor", () => {
  it("is stable and order-independent", () => {
    expect(groupIdFor(["A", "B"])).toBe(groupIdFor(["B", "A"]));
  });

  it("differs for different membership", () => {
    expect(groupIdFor(["A", "B"])).not.toBe(groupIdFor(["A", "C"]));
  });
});

describe("selectGroupName", () => {
  it("chooses the name from the highest-confidence SAME edge", () => {
    const { name } = selectGroupName([
      edge("A", "B", "same_underlying_issue", { confidence: 0.7, proposedRecurringIssueName: "Low confidence name" }),
      edge("B", "C", "same_underlying_issue", { confidence: 0.95, proposedRecurringIssueName: "High confidence name" }),
    ]);
    expect(name).toBe("High confidence name");
  });

  it("retains the other proposed names as alternates", () => {
    const { alternateNames } = selectGroupName([
      edge("A", "B", "same_underlying_issue", { confidence: 0.7, proposedRecurringIssueName: "Low confidence name" }),
      edge("B", "C", "same_underlying_issue", { confidence: 0.95, proposedRecurringIssueName: "High confidence name" }),
    ]);
    expect(alternateNames).toEqual(["Low confidence name"]);
  });

  it("breaks confidence ties by similarity", () => {
    const { name } = selectGroupName([
      edge("A", "B", "same_underlying_issue", { confidence: 0.9, similarity: 0.7, proposedRecurringIssueName: "Lower similarity" }),
      edge("B", "C", "same_underlying_issue", { confidence: 0.9, similarity: 0.88, proposedRecurringIssueName: "Higher similarity" }),
    ]);
    expect(name).toBe("Higher similarity");
  });

  it("deduplicates identical alternate names", () => {
    const { alternateNames } = selectGroupName([
      edge("A", "B", "same_underlying_issue", { confidence: 0.9, proposedRecurringIssueName: "Chosen" }),
      edge("B", "C", "same_underlying_issue", { confidence: 0.8, proposedRecurringIssueName: "Repeat" }),
      edge("A", "C", "same_underlying_issue", { confidence: 0.7, proposedRecurringIssueName: "Repeat" }),
    ]);
    expect(alternateNames).toEqual(["Repeat"]);
  });

  it("returns null when no SAME edge proposed a name", () => {
    expect(selectGroupName([edge("A", "B", "same_underlying_issue", { proposedRecurringIssueName: null })])).toEqual({
      name: null,
      alternateNames: [],
    });
  });

  it("invents no name of its own", () => {
    const { name } = selectGroupName([
      edge("A", "B", "same_underlying_issue", { proposedRecurringIssueName: "Only proposal" }),
    ]);
    expect(name).toBe("Only proposal");
  });
});

describe("buildRecurringIssueGroups — basic grouping", () => {
  it("builds a 2-member group from a single SAME edge", () => {
    const { groups, stats } = buildRecurringIssueGroups([edge(TS.A, TS.B, "same_underlying_issue")], emptyIndex);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.occurrenceCount).toBe(2);
    expect(groups[0]?.consistency).toBe("fully_confirmed");
    expect(stats.recurringGroups).toBe(1);
  });

  it("builds a 3-member group from a fully connected SAME triangle", () => {
    const { groups } = buildRecurringIssueGroups(
      [
        edge(TS.A, TS.B, "same_underlying_issue"),
        edge(TS.B, TS.C, "same_underlying_issue"),
        edge(TS.A, TS.C, "same_underlying_issue"),
      ],
      emptyIndex,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.occurrenceCount).toBe(3);
    expect(groups[0]?.consistency).toBe("fully_confirmed");
    expect(groups[0]?.sameEdges).toHaveLength(3);
  });

  it("counts unique escalations, not edges", () => {
    const { groups } = buildRecurringIssueGroups(
      [
        edge(TS.A, TS.B, "same_underlying_issue"),
        edge(TS.B, TS.C, "same_underlying_issue"),
        edge(TS.A, TS.C, "same_underlying_issue"),
      ],
      emptyIndex,
    );
    // 3 edges but 3 unique threads — occurrenceCount must be members, not edges.
    expect(groups[0]?.occurrenceCount).toBe(3);
    expect(groups[0]?.members).toHaveLength(3);
  });

  it("excludes RELATED and DIFFERENT pairs from forming groups", () => {
    const { groups, stats } = buildRecurringIssueGroups(
      [edge(TS.A, TS.B, "related_problem_family"), edge(TS.C, TS.D, "different")],
      emptyIndex,
    );

    expect(groups).toHaveLength(0);
    expect(stats.relatedEdges).toBe(1);
    expect(stats.differentEdges).toBe(1);
  });

  it("ignores failed adjudications", () => {
    const { groups } = buildRecurringIssueGroups(
      [edge(TS.A, TS.B, "same_underlying_issue", { status: "failed", relationship: undefined, error: "boom" })],
      emptyIndex,
    );
    expect(groups).toHaveLength(0);
  });
});

describe("buildRecurringIssueGroups — conflicts and transitivity", () => {
  it("does not merge A-B-C when A-C is RELATED", () => {
    const { groups, stats } = buildRecurringIssueGroups(
      [
        edge(TS.A, TS.B, "same_underlying_issue"),
        edge(TS.B, TS.C, "same_underlying_issue"),
        edge(TS.A, TS.C, "related_problem_family"),
      ],
      emptyIndex,
    );

    expect(stats.conflictedComponents).toBe(1);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.occurrenceCount === 2)).toBe(true);
    expect(groups.some((g) => g.members.map((m) => m.rootTs).includes(TS.A) && g.members.map((m) => m.rootTs).includes(TS.C))).toBe(false);
  });

  it("does not merge A-B-C when A-C is DIFFERENT", () => {
    const { groups, stats } = buildRecurringIssueGroups(
      [
        edge(TS.A, TS.B, "same_underlying_issue"),
        edge(TS.B, TS.C, "same_underlying_issue"),
        edge(TS.A, TS.C, "different"),
      ],
      emptyIndex,
    );

    expect(stats.conflictedComponents).toBe(1);
    expect(groups).toHaveLength(2);
  });

  it("marks split groups as coming from a conflicted component", () => {
    const { groups } = buildRecurringIssueGroups(
      [
        edge(TS.A, TS.B, "same_underlying_issue"),
        edge(TS.B, TS.C, "same_underlying_issue"),
        edge(TS.A, TS.C, "different"),
      ],
      emptyIndex,
    );
    expect(groups.every((g) => g.splitFromConflictedComponent)).toBe(true);
    expect(groups.every((g) => g.consistency === "fully_confirmed")).toBe(true);
  });

  it("reports overlapping membership after a conflict split rather than merging", () => {
    const { stats } = buildRecurringIssueGroups(
      [
        edge(TS.A, TS.B, "same_underlying_issue"),
        edge(TS.B, TS.C, "same_underlying_issue"),
        edge(TS.A, TS.C, "different"),
      ],
      emptyIndex,
    );

    expect(stats.overlappingMembers).toHaveLength(1);
    expect(stats.overlappingMembers[0]?.member).toBe(TS.B);
    expect(stats.overlappingGroups).toBe(2);
  });

  it("keeps a group whole but flags it when an internal pair was never adjudicated", () => {
    const { groups, stats } = buildRecurringIssueGroups(
      [edge(TS.A, TS.B, "same_underlying_issue"), edge(TS.B, TS.C, "same_underlying_issue")],
      emptyIndex,
    );

    // Missing evidence must not silently split the group into two.
    expect(groups).toHaveLength(1);
    expect(groups[0]?.occurrenceCount).toBe(3);
    expect(groups[0]?.consistency).toBe("incomplete_pair_evidence");
    expect(groups[0]?.unadjudicatedPairsInsideGroup).toEqual([memberPairKey(TS.A, TS.C)]);
    expect(stats.conflictedComponents).toBe(0);
  });
});

describe("buildRecurringIssueGroups — aggregation and metadata", () => {
  it("aggregates confidence and similarity across internal SAME edges", () => {
    const { groups } = buildRecurringIssueGroups(
      [
        edge(TS.A, TS.B, "same_underlying_issue", { confidence: 0.9, similarity: 0.88 }),
        edge(TS.B, TS.C, "same_underlying_issue", { confidence: 0.7, similarity: 0.62 }),
        edge(TS.A, TS.C, "same_underlying_issue", { confidence: 0.8, similarity: 0.7 }),
      ],
      emptyIndex,
    );

    const group = groups[0];
    expect(group?.averageSameEdgeConfidence).toBeCloseTo(0.8, 5);
    expect(group?.minimumSameEdgeConfidence).toBeCloseTo(0.7, 5);
    expect(group?.averageSameEdgeSimilarity).toBeCloseTo((0.88 + 0.62 + 0.7) / 3, 5);
    expect(group?.minimumSameEdgeSimilarity).toBeCloseTo(0.62, 5);
  });

  it("derives firstSeen and lastSeen from Slack rootTs", () => {
    const { groups } = buildRecurringIssueGroups([edge(TS.A, TS.C, "same_underlying_issue")], emptyIndex);

    expect(groups[0]?.firstSeen).toBe(new Date(Number.parseFloat(TS.A) * 1000).toISOString());
    expect(groups[0]?.lastSeen).toBe(new Date(Number.parseFloat(TS.C) * 1000).toISOString());
  });

  it("returns null dates rather than inventing them for an unparseable ts", () => {
    const { groups } = buildRecurringIssueGroups([edge("not-a-ts", "also-bad", "same_underlying_issue")], emptyIndex);
    expect(groups[0]?.firstSeen).toBeNull();
    expect(groups[0]?.lastSeen).toBeNull();
  });

  it("joins extraction metadata onto each member", () => {
    const index = new Map([
      [TS.A, analysis(TS.A, { severity: "critical" })],
      [TS.B, analysis(TS.B)],
    ]);
    const { groups } = buildRecurringIssueGroups([edge(TS.A, TS.B, "same_underlying_issue")], index);

    const member = groups[0]?.members.find((m) => m.rootTs === TS.A);
    expect(member?.severity).toBe("critical");
    expect(member?.customerImpact).toBe("multiple_customers");
    expect(member?.suspectedRootCause).toBe(`cause ${TS.A}`);
    expect(member?.resolutionSummary).toBe(`resolution ${TS.A}`);
  });

  it("falls back to adjudication data when extraction is missing", () => {
    const { groups } = buildRecurringIssueGroups([edge(TS.A, TS.B, "same_underlying_issue")], emptyIndex);
    const member = groups[0]?.members.find((m) => m.rootTs === TS.A);

    expect(member?.normalizedProblemStatement).toBe(`statement ${TS.A}`);
    expect(member?.permalink).toBe(`https://slack/${TS.A}`);
    expect(member?.severity).toBeNull();
  });

  it("orders groups by occurrence count, largest first", () => {
    const { groups } = buildRecurringIssueGroups(
      [
        edge(TS.A, TS.B, "same_underlying_issue"),
        edge(TS.B, TS.C, "same_underlying_issue"),
        edge(TS.A, TS.C, "same_underlying_issue"),
        edge(TS.D, "1779705560.815719", "same_underlying_issue"),
      ],
      emptyIndex,
    );

    expect(groups[0]?.occurrenceCount).toBe(3);
    expect(groups[1]?.occurrenceCount).toBe(2);
  });

  it("is deterministic across repeated runs", () => {
    const edges = [
      edge(TS.A, TS.B, "same_underlying_issue"),
      edge(TS.B, TS.C, "same_underlying_issue"),
      edge(TS.A, TS.C, "same_underlying_issue"),
    ];
    expect(buildRecurringIssueGroups(edges, emptyIndex)).toEqual(
      buildRecurringIssueGroups([...edges].reverse(), emptyIndex),
    );
  });

  it("reports component and edge statistics", () => {
    const { stats } = buildRecurringIssueGroups(
      [
        edge(TS.A, TS.B, "same_underlying_issue"),
        edge(TS.C, TS.D, "same_underlying_issue"),
        edge(TS.A, TS.C, "related_problem_family"),
        edge(TS.B, TS.D, "different"),
      ],
      emptyIndex,
    );

    expect(stats.sameEdges).toBe(2);
    expect(stats.relatedEdges).toBe(1);
    expect(stats.differentEdges).toBe(1);
    expect(stats.candidateComponents).toBe(2);
    expect(stats.recurringGroups).toBe(2);
  });
});
