import { describe, expect, it } from "vitest";
import {
  buildCandidatePairs,
  buildExtractionIndex,
  describeCandidateDistribution,
  filterCandidatesByFloor,
} from "../../src/adjudication/candidatePairs.js";
import type { SimilarPair } from "../../src/embeddings/nearestNeighbours.js";
import type { EscalationAnalysis } from "../../src/llm/schemas/escalationAnalysis.js";
import type { ExtractionOutput, ExtractionResultItem } from "../../src/persistence/extractionOutput.js";

function pair(aTs: string, bTs: string, similarity: number): SimilarPair {
  return {
    similarity,
    a: { rootTs: aTs, normalizedProblemStatement: `statement ${aTs}`, permalink: `https://slack/${aTs}` },
    b: { rootTs: bTs, normalizedProblemStatement: `statement ${bTs}`, permalink: `https://slack/${bTs}` },
  };
}

function analysis(rootTs: string, overrides: Partial<EscalationAnalysis> = {}): EscalationAnalysis {
  return {
    rootTs,
    permalink: `https://slack/${rootTs}`,
    isTechnicalEscalation: true,
    classification: "technical_defect",
    normalizedProblemStatement: `statement ${rootTs}`,
    affectedSystem: "billing",
    issueTypeHint: "calculation",
    severity: "high",
    customerImpact: "multiple_customers",
    suspectedRootCause: `root cause ${rootTs}`,
    rootCauseConfidence: 0.8,
    resolutionStatus: "resolved",
    resolutionSummary: `resolution ${rootTs}`,
    isRecurringEvidenceInThread: false,
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

function extractionOutput(results: ExtractionResultItem[]): ExtractionOutput {
  return {
    metadata: {
      inputFile: "data/slack/escalations-90d-2026-08-09.json",
      analysedAt: "2026-08-09T00:00:00.000Z",
      promptVersion: "v2",
      model: "claude-haiku-4-5",
      threadsAvailable: 164,
      threadsAnalysed: results.length,
      technicalEscalations: 70,
      nonTechnical: 94,
      failedExtractions: 0,
      sourceWindowDays: 90,
    },
    results,
  };
}

describe("filterCandidatesByFloor", () => {
  const pairs = [pair("1", "2", 0.9), pair("3", "4", 0.6), pair("5", "6", 0.5999), pair("7", "8", 0.1)];

  it("keeps pairs at or above the floor", () => {
    expect(filterCandidatesByFloor(pairs, 0.6).map((p) => p.similarity)).toEqual([0.9, 0.6]);
  });

  it("excludes everything below the floor", () => {
    expect(filterCandidatesByFloor(pairs, 0.6).some((p) => p.similarity < 0.6)).toBe(false);
  });

  it("treats the floor as inclusive", () => {
    expect(filterCandidatesByFloor([pair("1", "2", 0.6)], 0.6)).toHaveLength(1);
  });

  it("honours a configurable floor", () => {
    expect(filterCandidatesByFloor(pairs, 0.8)).toHaveLength(1);
    expect(filterCandidatesByFloor(pairs, 0.5)).toHaveLength(3);
    expect(filterCandidatesByFloor(pairs, 0.95)).toHaveLength(0);
  });
});

describe("buildExtractionIndex", () => {
  it("indexes successful extractions by rootTs", () => {
    const index = buildExtractionIndex(
      extractionOutput([
        { rootTs: "1", status: "success", analysis: analysis("1") },
        { rootTs: "2", status: "success", analysis: analysis("2") },
      ]),
    );
    expect(index.size).toBe(2);
    expect(index.get("1")?.suspectedRootCause).toBe("root cause 1");
  });

  it("omits failed extractions", () => {
    const index = buildExtractionIndex(
      extractionOutput([
        { rootTs: "1", status: "success", analysis: analysis("1") },
        { rootTs: "2", status: "failed", error: "boom" },
      ]),
    );
    expect(index.has("2")).toBe(false);
  });
});

describe("buildCandidatePairs", () => {
  const index = buildExtractionIndex(
    extractionOutput([
      { rootTs: "1", status: "success", analysis: analysis("1") },
      { rootTs: "2", status: "success", analysis: analysis("2") },
    ]),
  );

  it("joins extraction evidence onto both sides by rootTs", () => {
    const [candidate] = buildCandidatePairs([pair("1", "2", 0.9)], 0.6, index);

    expect(candidate?.a.suspectedRootCause).toBe("root cause 1");
    expect(candidate?.b.suspectedRootCause).toBe("root cause 2");
    expect(candidate?.a.affectedSystem).toBe("billing");
    expect(candidate?.b.resolutionSummary).toBe("resolution 2");
  });

  it("assigns an order-independent pairId", () => {
    const forward = buildCandidatePairs([pair("1", "2", 0.9)], 0.6, index);
    const reversed = buildCandidatePairs([pair("2", "1", 0.9)], 0.6, index);
    expect(forward[0]?.pairId).toBe(reversed[0]?.pairId);
  });

  it("preserves similarity and permalinks for the output record", () => {
    const [candidate] = buildCandidatePairs([pair("1", "2", 0.87)], 0.6, index);
    expect(candidate?.similarity).toBeCloseTo(0.87, 10);
    expect(candidate?.a.permalink).toBe("https://slack/1");
    expect(candidate?.b.permalink).toBe("https://slack/2");
  });

  it("still builds a candidate when extraction data is missing, with null fields", () => {
    const [candidate] = buildCandidatePairs([pair("1", "99", 0.9)], 0.6, index);
    expect(candidate?.b.suspectedRootCause).toBeNull();
    expect(candidate?.b.affectedSystem).toBeNull();
    expect(candidate?.b.normalizedProblemStatement).toBe("statement 99");
  });

  it("applies the floor before joining", () => {
    expect(buildCandidatePairs([pair("1", "2", 0.4)], 0.6, index)).toEqual([]);
  });
});

describe("describeCandidateDistribution", () => {
  it("counts candidates into the reporting bands", () => {
    const index = new Map<string, EscalationAnalysis>();
    const candidates = buildCandidatePairs(
      [pair("1", "2", 0.85), pair("3", "4", 0.76), pair("5", "6", 0.72), pair("7", "8", 0.66), pair("9", "10", 0.61)],
      0.6,
      index,
    );

    const counts = Object.fromEntries(describeCandidateDistribution(candidates).map((b) => [b.label, b.count]));
    expect(counts[">= 0.80"]).toBe(1);
    expect(counts["0.75 – 0.7999"]).toBe(1);
    expect(counts["0.70 – 0.7499"]).toBe(1);
    expect(counts["0.65 – 0.6999"]).toBe(1);
    expect(counts["0.60 – 0.6499"]).toBe(1);
  });

  it("returns zero counts for no candidates", () => {
    expect(describeCandidateDistribution([]).every((b) => b.count === 0)).toBe(true);
  });
});
