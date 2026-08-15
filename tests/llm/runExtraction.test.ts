import { describe, expect, it, vi } from "vitest";
import type { EscalationThread } from "../../src/slack/escalationThreads.js";
import type { EscalationParseFn } from "../../src/llm/extractEscalation.js";
import type { EscalationAnalysisLLMOutput } from "../../src/llm/schemas/escalationAnalysis.js";
import type { ExtractionResultItem } from "../../src/persistence/extractionOutput.js";
import {
  analyzeThreads,
  buildExtractionMetadata,
  computeExtractionTargets,
  estimateDryRunStats,
  pickLatestFetchFilename,
  type ProgressEvent,
} from "../../src/llm/runExtraction.js";

function makeThread(rootTs: string, rootText: string): EscalationThread {
  return {
    channelId: "C0SOURCE0000",
    rootTs,
    postedAt: "2026-08-01T00:00:00.000Z",
    authorId: "U1",
    rootText,
    replyCount: 0,
    permalink: `https://example.slack.com/archives/C0SOURCE0000/p${rootTs}`,
    replies: [],
  };
}

const analysisFor = (overrides: Partial<EscalationAnalysisLLMOutput> = {}): EscalationAnalysisLLMOutput => ({
  isTechnicalEscalation: true,
  classification: "technical_defect",
  normalizedProblemStatement: "some problem",
  affectedSystem: null,
  issueTypeHint: null,
  severity: "medium",
  customerImpact: "unknown",
  suspectedRootCause: null,
  rootCauseConfidence: null,
  resolutionStatus: "unclear",
  resolutionSummary: null,
  isRecurringEvidenceInThread: false,
  automationCandidate: "unclear",
  automationReasoning: null,
  isAutomationWorkflowCandidate: false,
  workflowClassification: null,
  normalizedWorkflowStatement: null,
  automationStatus: "unknown",
  confidence: 0.6,
  ...overrides,
});

describe("pickLatestFetchFilename", () => {
  it("picks the lexicographically latest matching filename", () => {
    const files = ["escalations-2026-08-01.json", "escalations-2026-08-09.json", "escalations-2026-07-15.json"];
    expect(pickLatestFetchFilename(files)).toBe("escalations-2026-08-09.json");
  });

  it("ignores non-matching filenames", () => {
    const files = ["README.md", "escalations-2026-08-01.json", "notes.txt"];
    expect(pickLatestFetchFilename(files)).toBe("escalations-2026-08-01.json");
  });

  it("returns null when nothing matches", () => {
    expect(pickLatestFetchFilename(["README.md"])).toBeNull();
  });
});

describe("computeExtractionTargets", () => {
  const threads = [makeThread("1", "a"), makeThread("2", "b"), makeThread("3", "c")];

  it("returns all threads when no limit is given", () => {
    expect(computeExtractionTargets(threads)).toEqual(threads);
  });

  it("slices to the first N threads when a limit is given", () => {
    expect(computeExtractionTargets(threads, 2)).toEqual([threads[0], threads[1]]);
  });
});

describe("estimateDryRunStats", () => {
  it("computes character and rough token estimates without calling any LLM", () => {
    const threads = [makeThread("1", "short"), makeThread("2", "a much longer message about a bulk upload failure")];
    const stats = estimateDryRunStats(threads);

    expect(stats.threadCount).toBe(2);
    expect(stats.totalCombinedChars).toBeGreaterThan(0);
    expect(stats.averageCharsPerThread).toBe(Math.round(stats.totalCombinedChars / 2));
    expect(stats.approxTotalInputTokens).toBe(Math.round(stats.totalCombinedChars / 4));
  });

  it("returns zeroes for an empty thread list", () => {
    const stats = estimateDryRunStats([]);
    expect(stats).toEqual({
      threadCount: 0,
      totalCombinedChars: 0,
      averageCharsPerThread: 0,
      approxTotalInputTokens: 0,
    });
  });
});

describe("analyzeThreads", () => {
  it("reuses a cached prior result instead of calling the LLM", async () => {
    const thread = makeThread("1", "a");
    const parseFn: EscalationParseFn = vi.fn();
    const cached: ExtractionResultItem = { rootTs: "1", status: "success", analysis: { ...analysisFor(), rootTs: "1", permalink: null } };
    const priorResultsIndex = new Map([["1::v1::claude-haiku-4-5", cached]]);

    const events: ProgressEvent[] = [];
    const results = await analyzeThreads({
      threads: [thread],
      parseFn,
      model: "claude-haiku-4-5",
      promptVersion: "v1",
      priorResultsIndex,
      onProgress: (e) => events.push(e),
    });

    expect(parseFn).not.toHaveBeenCalled();
    expect(results).toEqual([cached]);
    expect(events[0]?.outcome).toBe("cached");
  });

  it("calls the LLM for a thread with no cached result and records success", async () => {
    const thread = makeThread("2", "b");
    const parseFn: EscalationParseFn = vi.fn(async () => ({ parsed_output: analysisFor(), stop_reason: "end_turn" }));

    const results = await analyzeThreads({
      threads: [thread],
      parseFn,
      model: "claude-haiku-4-5",
      promptVersion: "v1",
      priorResultsIndex: new Map(),
    });

    expect(parseFn).toHaveBeenCalledTimes(1);
    expect(results[0]?.status).toBe("success");
    expect(results[0]?.analysis?.rootTs).toBe("2");
  });

  it("records a failure for one thread but keeps processing the rest", async () => {
    const threads = [makeThread("1", "a"), makeThread("2", "b"), makeThread("3", "c")];
    let call = 0;
    const parseFn: EscalationParseFn = vi.fn(async () => {
      call += 1;
      if (call === 2) {
        throw new Error("boom");
      }
      return { parsed_output: analysisFor(), stop_reason: "end_turn" };
    });

    const results = await analyzeThreads({
      threads,
      parseFn,
      model: "claude-haiku-4-5",
      promptVersion: "v1",
      priorResultsIndex: new Map(),
      sleep: () => Promise.resolve(),
    });

    expect(results).toHaveLength(3);
    expect(results[0]?.status).toBe("success");
    expect(results[1]?.status).toBe("failed");
    expect(results[1]?.error).toContain("boom");
    expect(results[2]?.status).toBe("success");
  });
});

describe("buildExtractionMetadata", () => {
  it("computes classification and failure counts from results", () => {
    const results: ExtractionResultItem[] = [
      { rootTs: "1", status: "success", analysis: { ...analysisFor({ isTechnicalEscalation: true }), rootTs: "1", permalink: null } },
      { rootTs: "2", status: "success", analysis: { ...analysisFor({ isTechnicalEscalation: false }), rootTs: "2", permalink: null } },
      { rootTs: "3", status: "failed", error: "boom" },
    ];

    const metadata = buildExtractionMetadata({
      inputFile: "data/slack/escalations-2026-08-09.json",
      analysedAt: new Date("2026-08-09T00:00:00.000Z"),
      promptVersion: "v1",
      model: "claude-haiku-4-5",
      threadsAvailable: 57,
      results,
    });

    expect(metadata).toMatchObject({
      inputFile: "data/slack/escalations-2026-08-09.json",
      analysedAt: "2026-08-09T00:00:00.000Z",
      promptVersion: "v1",
      model: "claude-haiku-4-5",
      threadsAvailable: 57,
      threadsAnalysed: 3,
      technicalEscalations: 1,
      nonTechnical: 1,
      failedExtractions: 1,
    });
    // The workflow dimension is reported alongside, never folded into the above.
    expect(metadata.workflowCandidates).toBe(0);
    expect(metadata.technicalOnly).toBe(1);
    expect(metadata.neither).toBe(1);
    // A failed record belongs to no bucket.
    expect(
      (metadata.technicalAndWorkflow ?? 0) +
        (metadata.workflowOnly ?? 0) +
        (metadata.technicalOnly ?? 0) +
        (metadata.neither ?? 0),
    ).toBe(2);
  });
});
