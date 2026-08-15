import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPriorResultsIndex,
  extractionOutputFilePath,
  lookupPriorResult,
  writeExtractionOutput,
  type ExtractionOutput,
} from "../src/persistence/extractionOutput.js";
import type { EscalationAnalysis } from "../src/llm/schemas/escalationAnalysis.js";

function makeAnalysis(rootTs: string): EscalationAnalysis {
  return {
    rootTs,
    permalink: null,
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
  };
}

describe("extractionOutputFilePath", () => {
  it("names the file with the analysis date in YYYY-MM-DD form", () => {
    const filePath = extractionOutputFilePath("/tmp/data/intelligence", new Date("2026-08-09T12:00:00.000Z"));
    expect(filePath).toBe(path.join("/tmp/data/intelligence", "extractions-2026-08-09.json"));
  });

  it("carries the source window tag through", () => {
    const filePath = extractionOutputFilePath("/tmp/data/intelligence", new Date("2026-08-09T12:00:00.000Z"), "90d");
    expect(filePath).toBe(path.join("/tmp/data/intelligence", "extractions-90d-2026-08-09.json"));
  });

  it("does not collide across windows on the same day", () => {
    const day = new Date("2026-08-09T12:00:00.000Z");
    expect(extractionOutputFilePath("/d", day, "30d")).not.toBe(extractionOutputFilePath("/d", day, "90d"));
  });
});

describe("writeExtractionOutput", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes valid JSON matching the documented output shape", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "escalation-intelligence-extract-test-"));
    const filePath = extractionOutputFilePath(dir, new Date("2026-08-09T00:00:00.000Z"));

    const output: ExtractionOutput = {
      metadata: {
        inputFile: "data/slack/escalations-2026-08-09.json",
        analysedAt: "2026-08-09T00:00:00.000Z",
        promptVersion: "v1",
        model: "claude-haiku-4-5",
        threadsAvailable: 57,
        threadsAnalysed: 5,
        technicalEscalations: 3,
        nonTechnical: 2,
        failedExtractions: 0,
      },
      results: [
        { rootTs: "1", status: "success", analysis: makeAnalysis("1") },
        { rootTs: "2", status: "failed", error: "boom" },
      ],
    };

    await writeExtractionOutput(output, filePath);
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as ExtractionOutput;

    expect(parsed).toEqual(output);
  });
});

describe("buildPriorResultsIndex / lookupPriorResult", () => {
  it("indexes only successful results, keyed by rootTs + promptVersion + model", () => {
    const priorOutputs: ExtractionOutput[] = [
      {
        metadata: {
          inputFile: "x",
          analysedAt: "2026-08-01T00:00:00.000Z",
          promptVersion: "v1",
          model: "claude-haiku-4-5",
          threadsAvailable: 2,
          threadsAnalysed: 2,
          technicalEscalations: 1,
          nonTechnical: 0,
          failedExtractions: 1,
        },
        results: [
          { rootTs: "1", status: "success", analysis: makeAnalysis("1") },
          { rootTs: "2", status: "failed", error: "boom" },
        ],
      },
    ];

    const index = buildPriorResultsIndex(priorOutputs);

    expect(lookupPriorResult(index, "1", "v1", "claude-haiku-4-5")).toBeDefined();
    expect(lookupPriorResult(index, "2", "v1", "claude-haiku-4-5")).toBeUndefined();
    expect(lookupPriorResult(index, "1", "v2", "claude-haiku-4-5")).toBeUndefined();
    expect(lookupPriorResult(index, "1", "v1", "claude-sonnet-5")).toBeUndefined();
  });
});
