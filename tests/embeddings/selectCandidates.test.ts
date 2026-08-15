import { describe, expect, it } from "vitest";
import {
  assertEmbeddingCandidatesSafe,
  assertExtractionPromptVersion,
  ExtractionVersionError,
  selectEmbeddingCandidates,
  UnsafeEmbeddingPayloadError,
  type EmbeddingCandidate,
} from "../../src/embeddings/selectCandidates.js";
import type { ExtractionOutput, ExtractionResultItem } from "../../src/persistence/extractionOutput.js";
import type { EscalationAnalysis } from "../../src/llm/schemas/escalationAnalysis.js";

function makeAnalysis(overrides: Partial<EscalationAnalysis> = {}): EscalationAnalysis {
  return {
    rootTs: "1",
    permalink: "https://example.slack.com/p1",
    isTechnicalEscalation: true,
    classification: "technical_defect",
    normalizedProblemStatement: "Bulk upload times out for large batches",
    affectedSystem: null,
    issueTypeHint: null,
    severity: "medium",
    customerImpact: "unknown",
    suspectedRootCause: "Some detailed root cause that must never be embedded",
    rootCauseConfidence: 0.4,
    resolutionStatus: "unclear",
    resolutionSummary: "A long resolution summary that must never be embedded",
    isRecurringEvidenceInThread: false,
    automationCandidate: "unclear",
    automationReasoning: "Reasoning that must never be embedded",
    isAutomationWorkflowCandidate: false,
    workflowClassification: null,
    normalizedWorkflowStatement: null,
    automationStatus: "unknown",
    confidence: 0.7,
    ...overrides,
  };
}

function makeOutput(results: ExtractionResultItem[], promptVersion = "v3"): ExtractionOutput {
  return {
    metadata: {
      inputFile: "data/slack/escalations-2026-08-09.json",
      analysedAt: "2026-08-09T00:00:00.000Z",
      promptVersion,
      model: "claude-haiku-4-5",
      threadsAvailable: 57,
      threadsAnalysed: results.length,
      technicalEscalations: 0,
      nonTechnical: 0,
      failedExtractions: 0,
    },
    results,
  };
}

describe("assertExtractionPromptVersion", () => {
  it("accepts a v3 extraction file", () => {
    expect(() => assertExtractionPromptVersion(makeOutput([], "v3"), "f.json")).not.toThrow();
  });

  it("rejects an older extraction file with an actionable message", () => {
    expect(() => assertExtractionPromptVersion(makeOutput([], "v2"), "f.json")).toThrow(ExtractionVersionError);
    expect(() => assertExtractionPromptVersion(makeOutput([], "v2"), "f.json")).toThrow(/intelligence:extract/);
  });
});

describe("selectEmbeddingCandidates", () => {
  it("keeps only technical escalations with a non-null statement", () => {
    const output = makeOutput([
      { rootTs: "1", status: "success", analysis: makeAnalysis({ rootTs: "1" }) },
      {
        rootTs: "2",
        status: "success",
        analysis: makeAnalysis({ rootTs: "2", isTechnicalEscalation: false, normalizedProblemStatement: null }),
      },
      { rootTs: "3", status: "failed", error: "boom" },
      {
        rootTs: "4",
        status: "success",
        analysis: makeAnalysis({ rootTs: "4", isTechnicalEscalation: true, normalizedProblemStatement: null }),
      },
    ]);

    const candidates = selectEmbeddingCandidates(output);

    expect(candidates.map((c) => c.rootTs)).toEqual(["1"]);
  });

  it("excludes non-technical items even if they somehow carry a statement", () => {
    const output = makeOutput([
      {
        rootTs: "1",
        status: "success",
        analysis: makeAnalysis({ isTechnicalEscalation: false, normalizedProblemStatement: "leaked statement" }),
      },
    ]);

    expect(selectEmbeddingCandidates(output)).toEqual([]);
  });

  it("excludes failed extractions", () => {
    const output = makeOutput([{ rootTs: "1", status: "failed", error: "boom" }]);
    expect(selectEmbeddingCandidates(output)).toEqual([]);
  });

  it("carries only the fields needed downstream — never root cause, resolution, or automation text", () => {
    const output = makeOutput([{ rootTs: "1", status: "success", analysis: makeAnalysis() }]);
    const candidate = selectEmbeddingCandidates(output)[0] as EmbeddingCandidate;

    expect(Object.keys(candidate).sort()).toEqual([
      "category",
      "classification",
      "isTechnicalEscalation",
      "normalizedProblemStatement",
      "permalink",
      "rootTs",
    ]);
    expect(JSON.stringify(candidate)).not.toContain("must never be embedded");
  });
});

describe("assertEmbeddingCandidatesSafe", () => {
  const safeCandidate: EmbeddingCandidate = {
    rootTs: "1",
    normalizedProblemStatement: "Bulk upload times out",
    classification: "technical_defect",
    permalink: null,
    isTechnicalEscalation: true,
    category: "technical",
  };

  it("passes for eligible candidates", () => {
    expect(() => assertEmbeddingCandidatesSafe([safeCandidate])).not.toThrow();
  });

  it("passes for an empty list", () => {
    expect(() => assertEmbeddingCandidatesSafe([])).not.toThrow();
  });

  it("throws if a non-technical item reaches the payload", () => {
    const unsafe = { ...safeCandidate, isTechnicalEscalation: false };
    expect(() => assertEmbeddingCandidatesSafe([unsafe])).toThrow(UnsafeEmbeddingPayloadError);
    expect(() => assertEmbeddingCandidatesSafe([unsafe])).toThrow(/isTechnicalEscalation is not true/);
  });

  it("throws if a statement is empty or whitespace-only", () => {
    expect(() => assertEmbeddingCandidatesSafe([{ ...safeCandidate, normalizedProblemStatement: "" }])).toThrow(
      UnsafeEmbeddingPayloadError,
    );
    expect(() => assertEmbeddingCandidatesSafe([{ ...safeCandidate, normalizedProblemStatement: "   " }])).toThrow(
      UnsafeEmbeddingPayloadError,
    );
  });

  it("names the offending thread so the failure is diagnosable", () => {
    const unsafe = { ...safeCandidate, rootTs: "999.0", isTechnicalEscalation: false };
    expect(() => assertEmbeddingCandidatesSafe([unsafe])).toThrow(/999\.0/);
  });
});
