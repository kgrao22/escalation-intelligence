import { describe, expect, it } from "vitest";
import type { RecurringIssueGroup, RecurringIssueMember } from "../../src/groups/buildGroups.js";
import { analyzeGroup } from "../../src/report/analyzeGroup.js";
import {
  distribute,
  SEVERITY_ORDER,
  toCustomerImpactBucket,
  toResolutionStatusBucket,
  toSeverityBucket,
} from "../../src/report/distributions.js";

const ASOF = new Date("2026-08-10T00:00:00.000Z");

export function member(overrides: Partial<RecurringIssueMember> = {}): RecurringIssueMember {
  return {
    rootTs: "1781246131.192699",
    normalizedProblemStatement: "A statement",
    permalink: "https://slack/a",
    postedAt: "2026-06-01T00:00:00.000Z",
    classification: "technical_defect",
    affectedSystem: "billing",
    severity: "high",
    customerImpact: "single_customer",
    suspectedRootCause: "cause",
    resolutionStatus: "resolved",
    resolutionSummary: "fixed",
    ...overrides,
  };
}

export function group(overrides: Partial<RecurringIssueGroup> = {}): RecurringIssueGroup {
  const members = overrides.members ?? [member(), member({ rootTs: "b", postedAt: "2026-07-01T00:00:00.000Z" })];
  return {
    groupId: "grp_test000001",
    name: "Test issue",
    alternateNames: [],
    members,
    occurrenceCount: members.length,
    firstSeen: "2026-06-01T00:00:00.000Z",
    lastSeen: "2026-07-01T00:00:00.000Z",
    averageSameEdgeConfidence: 0.9,
    minimumSameEdgeConfidence: 0.9,
    averageSameEdgeSimilarity: 0.8,
    minimumSameEdgeSimilarity: 0.8,
    consistency: "fully_confirmed",
    splitFromConflictedComponent: false,
    sameEdges: ["a::b"],
    relatedEdgesInsideGroup: [],
    differentEdgesInsideGroup: [],
    unadjudicatedPairsInsideGroup: [],
    ...overrides,
  };
}

describe("bucket mapping", () => {
  it("maps known enum values through unchanged", () => {
    expect(toSeverityBucket("critical")).toBe("critical");
    expect(toCustomerImpactBucket("multiple_customers")).toBe("multiple_customers");
    expect(toResolutionStatusBucket("workaround")).toBe("workaround");
  });

  it("maps null and undefined to unspecified rather than an existing enum value", () => {
    expect(toSeverityBucket(null)).toBe("unspecified");
    expect(toSeverityBucket(undefined)).toBe("unspecified");
    expect(toResolutionStatusBucket(null)).toBe("unspecified");
    // "unclear" is a real adjudicated value and must not absorb missing data.
    expect(toResolutionStatusBucket(null)).not.toBe("unclear");
  });

  it("maps unrecognised values to unspecified", () => {
    expect(toSeverityBucket("catastrophic")).toBe("unspecified");
  });
});

describe("distribute", () => {
  it("retains empty buckets so the shape is stable", () => {
    const result = distribute(["high", "high"], SEVERITY_ORDER);
    expect(result).toHaveLength(SEVERITY_ORDER.length);
    expect(result.find((entry) => entry.value === "high")?.count).toBe(2);
    expect(result.find((entry) => entry.value === "low")?.count).toBe(0);
  });

  it("preserves canonical ordering", () => {
    expect(distribute([], SEVERITY_ORDER).map((entry) => entry.value)).toEqual([...SEVERITY_ORDER]);
  });
});

describe("analyzeGroup — distributions", () => {
  it("counts severity across occurrences", () => {
    const analyzed = analyzeGroup(
      group({ members: [member({ severity: "critical" }), member({ severity: "high" }), member({ severity: "high" })] }),
      ASOF,
    );
    const counts = Object.fromEntries(analyzed.severityDistribution.map((e) => [e.value, e.count]));
    expect(counts.critical).toBe(1);
    expect(counts.high).toBe(2);
    expect(counts.low).toBe(0);
  });

  it("counts customer impact across occurrences", () => {
    const analyzed = analyzeGroup(
      group({
        members: [member({ customerImpact: "multiple_customers" }), member({ customerImpact: "single_customer" })],
      }),
      ASOF,
    );
    const counts = Object.fromEntries(analyzed.customerImpactDistribution.map((e) => [e.value, e.count]));
    expect(counts.multiple_customers).toBe(1);
    expect(counts.single_customer).toBe(1);
  });

  it("counts resolution status across occurrences", () => {
    const analyzed = analyzeGroup(
      group({
        members: [
          member({ resolutionStatus: "unresolved" }),
          member({ resolutionStatus: "workaround" }),
          member({ resolutionStatus: "resolved" }),
        ],
      }),
      ASOF,
    );
    const counts = Object.fromEntries(analyzed.resolutionStatusDistribution.map((e) => [e.value, e.count]));
    expect(counts.unresolved).toBe(1);
    expect(counts.workaround).toBe(1);
    expect(counts.resolved).toBe(1);
  });

  it("reports peak severity and impact", () => {
    const analyzed = analyzeGroup(
      group({
        members: [
          member({ severity: "low", customerImpact: "none" }),
          member({ severity: "critical", customerImpact: "multiple_customers" }),
        ],
      }),
      ASOF,
    );
    expect(analyzed.peakSeverity).toBe("critical");
    expect(analyzed.peakCustomerImpact).toBe("multiple_customers");
  });

  it("collects distinct affected systems, sorted", () => {
    const analyzed = analyzeGroup(
      group({
        members: [
          member({ affectedSystem: "policy" }),
          member({ affectedSystem: "billing" }),
          member({ affectedSystem: "billing" }),
        ],
      }),
      ASOF,
    );
    expect(analyzed.affectedSystems).toEqual(["billing", "policy"]);
  });
});

describe("analyzeGroup — recurrence window", () => {
  it("computes span in whole days", () => {
    const analyzed = analyzeGroup(
      group({ firstSeen: "2026-06-01T00:00:00.000Z", lastSeen: "2026-07-01T00:00:00.000Z" }),
      ASOF,
    );
    expect(analyzed.window.spanDays).toBe(30);
  });

  it("computes the average gap between occurrences", () => {
    const analyzed = analyzeGroup(
      group({
        members: [member(), member({ rootTs: "b" }), member({ rootTs: "c" })],
        occurrenceCount: 3,
        firstSeen: "2026-06-01T00:00:00.000Z",
        lastSeen: "2026-07-01T00:00:00.000Z",
      }),
      ASOF,
    );
    // 30 days across 3 occurrences → 2 gaps → 15 days each.
    expect(analyzed.window.averageDaysBetweenOccurrences).toBeCloseTo(15, 5);
  });

  it("computes days since the last occurrence relative to asOf", () => {
    const analyzed = analyzeGroup(group({ lastSeen: "2026-08-01T00:00:00.000Z" }), ASOF);
    expect(analyzed.window.daysSinceLastOccurrence).toBe(9);
  });

  it("returns null span rather than inventing dates when they are missing", () => {
    const analyzed = analyzeGroup(group({ firstSeen: null, lastSeen: null }), ASOF);
    expect(analyzed.window.spanDays).toBeNull();
    expect(analyzed.window.averageDaysBetweenOccurrences).toBeNull();
    expect(analyzed.window.daysSinceLastOccurrence).toBeNull();
  });

  it("returns a null average gap for a single-occurrence group", () => {
    const analyzed = analyzeGroup(group({ members: [member()], occurrenceCount: 1 }), ASOF);
    expect(analyzed.window.averageDaysBetweenOccurrences).toBeNull();
  });

  it("reports a zero span when all occurrences share a timestamp", () => {
    const analyzed = analyzeGroup(
      group({ firstSeen: "2026-06-01T00:00:00.000Z", lastSeen: "2026-06-01T00:00:00.000Z" }),
      ASOF,
    );
    expect(analyzed.window.spanDays).toBe(0);
  });
});

describe("analyzeGroup — resolution posture", () => {
  it("flags remaining unresolved occurrences", () => {
    const analyzed = analyzeGroup(
      group({ members: [member({ resolutionStatus: "unresolved" }), member({ resolutionStatus: "resolved" })] }),
      ASOF,
    );
    expect(analyzed.resolution.unresolvedCount).toBe(1);
    expect(analyzed.resolution.hasUnresolvedOccurrences).toBe(true);
    expect(analyzed.resolution.hasOpenOccurrences).toBe(true);
    expect(analyzed.resolution.fullyResolved).toBe(false);
  });

  it("treats a workaround as still open", () => {
    const analyzed = analyzeGroup(
      group({ members: [member({ resolutionStatus: "workaround" }), member({ resolutionStatus: "resolved" })] }),
      ASOF,
    );
    expect(analyzed.resolution.hasWorkaroundOccurrences).toBe(true);
    expect(analyzed.resolution.hasOpenOccurrences).toBe(true);
    expect(analyzed.resolution.openCount).toBe(1);
  });

  it("counts unresolved and workaround together as open", () => {
    const analyzed = analyzeGroup(
      group({ members: [member({ resolutionStatus: "unresolved" }), member({ resolutionStatus: "workaround" })] }),
      ASOF,
    );
    expect(analyzed.resolution.openCount).toBe(2);
  });

  it("reports fullyResolved when every occurrence was resolved", () => {
    const analyzed = analyzeGroup(
      group({ members: [member({ resolutionStatus: "resolved" }), member({ resolutionStatus: "resolved" })] }),
      ASOF,
    );
    expect(analyzed.resolution.fullyResolved).toBe(true);
    expect(analyzed.resolution.hasOpenOccurrences).toBe(false);
  });

  it("does not treat unclear or not_applicable as resolved or open", () => {
    const analyzed = analyzeGroup(
      group({ members: [member({ resolutionStatus: "unclear" }), member({ resolutionStatus: "not_applicable" })] }),
      ASOF,
    );
    expect(analyzed.resolution.openCount).toBe(0);
    expect(analyzed.resolution.fullyResolved).toBe(false);
  });
});

describe("analyzeGroup — passthrough", () => {
  it("carries occurrence count, consistency, and review flag", () => {
    const analyzed = analyzeGroup(group({ consistency: "incomplete_pair_evidence" }), ASOF);
    expect(analyzed.occurrenceCount).toBe(2);
    expect(analyzed.consistency).toBe("incomplete_pair_evidence");
    expect(analyzed.needsReview).toBe(true);
  });

  it("does not flag a fully confirmed group for review", () => {
    expect(analyzeGroup(group(), ASOF).needsReview).toBe(false);
  });

  it("retains per-occurrence permalinks for rendering", () => {
    const analyzed = analyzeGroup(group(), ASOF);
    expect(analyzed.occurrences).toHaveLength(2);
    expect(analyzed.occurrences[0]?.permalink).toBe("https://slack/a");
  });
});
