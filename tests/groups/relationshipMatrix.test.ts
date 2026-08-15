import { describe, expect, it } from "vitest";
import {
  allMemberPairs,
  assessGroupConsistency,
  buildRelationshipMatrix,
  memberPairKey,
} from "../../src/groups/relationshipMatrix.js";
import type { Relationship } from "../../src/llm/schemas/recurrenceAdjudication.js";
import type { AdjudicationResultItem } from "../../src/persistence/adjudicationOutput.js";

export function edge(a: string, b: string, relationship: Relationship, overrides: Partial<AdjudicationResultItem> = {}): AdjudicationResultItem {
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

describe("memberPairKey", () => {
  it("is order-independent", () => {
    expect(memberPairKey("A", "B")).toBe(memberPairKey("B", "A"));
  });
});

describe("buildRelationshipMatrix", () => {
  const matrix = buildRelationshipMatrix([
    edge("A", "B", "same_underlying_issue"),
    edge("B", "C", "related_problem_family"),
    edge("C", "D", "different"),
    edge("E", "F", "same_underlying_issue", { status: "failed", relationship: undefined, error: "boom" }),
  ]);

  it("looks up a relationship in either direction", () => {
    expect(matrix.relationship("A", "B")).toBe("same_underlying_issue");
    expect(matrix.relationship("B", "A")).toBe("same_underlying_issue");
  });

  it("returns each adjudicated relationship type", () => {
    expect(matrix.relationship("B", "C")).toBe("related_problem_family");
    expect(matrix.relationship("C", "D")).toBe("different");
  });

  it("reports never-adjudicated pairs distinctly from different", () => {
    expect(matrix.relationship("A", "Z")).toBe("no_adjudication");
    expect(matrix.relationship("A", "Z")).not.toBe("different");
  });

  it("ignores failed adjudications", () => {
    expect(matrix.relationship("E", "F")).toBe("no_adjudication");
  });

  it("collects only successful SAME edges", () => {
    expect(matrix.sameEdges).toHaveLength(1);
    expect(matrix.sameEdges[0]?.a.rootTs).toBe("A");
  });
});

describe("allMemberPairs", () => {
  it("returns each unordered pair exactly once", () => {
    expect(allMemberPairs(["C", "A", "B"])).toEqual([
      ["A", "B"],
      ["A", "C"],
      ["B", "C"],
    ]);
  });

  it("returns no pairs for a single member", () => {
    expect(allMemberPairs(["A"])).toEqual([]);
  });

  it("produces n*(n-1)/2 pairs", () => {
    expect(allMemberPairs(["A", "B", "C", "D"])).toHaveLength(6);
  });
});

describe("assessGroupConsistency", () => {
  it("reports fully_confirmed when every internal pair is SAME", () => {
    const matrix = buildRelationshipMatrix([
      edge("A", "B", "same_underlying_issue"),
      edge("B", "C", "same_underlying_issue"),
      edge("A", "C", "same_underlying_issue"),
    ]);
    const report = assessGroupConsistency(["A", "B", "C"], matrix);

    expect(report.consistency).toBe("fully_confirmed");
    expect(report.sameEdges).toHaveLength(3);
    expect(report.unadjudicatedPairs).toEqual([]);
  });

  it("reports incomplete_pair_evidence when a pair was never adjudicated", () => {
    const matrix = buildRelationshipMatrix([
      edge("A", "B", "same_underlying_issue"),
      edge("B", "C", "same_underlying_issue"),
    ]);
    const report = assessGroupConsistency(["A", "B", "C"], matrix);

    expect(report.consistency).toBe("incomplete_pair_evidence");
    expect(report.unadjudicatedPairs).toEqual([memberPairKey("A", "C")]);
  });

  it("reports conflicted when an internal pair is RELATED", () => {
    const matrix = buildRelationshipMatrix([
      edge("A", "B", "same_underlying_issue"),
      edge("B", "C", "same_underlying_issue"),
      edge("A", "C", "related_problem_family"),
    ]);
    const report = assessGroupConsistency(["A", "B", "C"], matrix);

    expect(report.consistency).toBe("conflicted");
    expect(report.relatedEdgesInsideGroup).toEqual([memberPairKey("A", "C")]);
  });

  it("reports conflicted when an internal pair is DIFFERENT", () => {
    const matrix = buildRelationshipMatrix([
      edge("A", "B", "same_underlying_issue"),
      edge("B", "C", "same_underlying_issue"),
      edge("A", "C", "different"),
    ]);
    const report = assessGroupConsistency(["A", "B", "C"], matrix);

    expect(report.consistency).toBe("conflicted");
    expect(report.differentEdgesInsideGroup).toEqual([memberPairKey("A", "C")]);
  });

  it("prefers conflicted over incomplete when both are present", () => {
    const matrix = buildRelationshipMatrix([
      edge("A", "B", "same_underlying_issue"),
      edge("B", "C", "same_underlying_issue"),
      edge("C", "D", "same_underlying_issue"),
      edge("A", "C", "different"),
    ]);
    const report = assessGroupConsistency(["A", "B", "C", "D"], matrix);

    expect(report.consistency).toBe("conflicted");
    expect(report.unadjudicatedPairs.length).toBeGreaterThan(0);
  });

  it("treats a 2-member SAME pair as fully_confirmed", () => {
    const matrix = buildRelationshipMatrix([edge("A", "B", "same_underlying_issue")]);
    expect(assessGroupConsistency(["A", "B"], matrix).consistency).toBe("fully_confirmed");
  });
});
