import { describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import type { EscalationThread } from "../../src/slack/escalationThreads.js";
import {
  ExtractionParseError,
  ExtractionRefusedError,
  extractEscalationAnalysis,
  type EscalationParseFn,
  type EscalationParseResponse,
} from "../../src/llm/extractEscalation.js";
import type { EscalationAnalysisLLMOutput } from "../../src/llm/schemas/escalationAnalysis.js";

const thread: EscalationThread = {
  channelId: "C0SOURCE0000",
  rootTs: "178.0",
  postedAt: "2026-08-01T00:00:00.000Z",
  authorId: "U1",
  rootText: "Bulk upload failed for 300 vehicles",
  replyCount: 0,
  permalink: "https://example.slack.com/archives/C0SOURCE0000/p178",
  replies: [],
};

const validAnalysis: EscalationAnalysisLLMOutput = {
  isTechnicalEscalation: true,
  classification: "technical_defect",
  normalizedProblemStatement: "Bulk vehicle upload fails for large batches",
  affectedSystem: "fleet-upload-service",
  issueTypeHint: "batch processing failure",
  severity: "high",
  customerImpact: "single_customer",
  suspectedRootCause: null,
  rootCauseConfidence: null,
  resolutionStatus: "unresolved",
  resolutionSummary: null,
  isRecurringEvidenceInThread: false,
  automationCandidate: "permanent_code_fix",
  automationReasoning: null,
    isAutomationWorkflowCandidate: false,
    workflowClassification: null,
    normalizedWorkflowStatement: null,
    automationStatus: "unknown",
  confidence: 0.75,
};

function makeParseFn(response: EscalationParseResponse | (() => Promise<EscalationParseResponse>)): EscalationParseFn {
  return vi.fn(async () => (typeof response === "function" ? response() : response));
}

const noSleep = () => Promise.resolve();

describe("extractEscalationAnalysis — classification parsing", () => {
  it("attaches rootTs and permalink from the thread to a successful parse", async () => {
    const parseFn = makeParseFn({ parsed_output: validAnalysis, stop_reason: "end_turn" });

    const result = await extractEscalationAnalysis(parseFn, "claude-haiku-4-5", thread);

    expect(result.rootTs).toBe("178.0");
    expect(result.permalink).toBe("https://example.slack.com/archives/C0SOURCE0000/p178");
    expect(result.classification).toBe("technical_defect");
    expect(result.isTechnicalEscalation).toBe(true);
  });

  it("passes the model, system prompt, and cleaned user prompt through to the parse function", async () => {
    const parseFn = makeParseFn({ parsed_output: validAnalysis, stop_reason: "end_turn" });

    await extractEscalationAnalysis(parseFn, "claude-sonnet-5", thread);

    expect(parseFn).toHaveBeenCalledTimes(1);
    const call = vi.mocked(parseFn).mock.calls[0]?.[0];
    expect(call?.model).toBe("claude-sonnet-5");
    expect(call?.systemPrompt.toLowerCase()).toContain("de-identification");
    expect(call?.userPrompt).toContain("Bulk upload failed for 300 vehicles");
  });

  it("sets permalink to null when the thread has none", async () => {
    const parseFn = makeParseFn({ parsed_output: validAnalysis, stop_reason: "end_turn" });
    const threadWithoutPermalink = { ...thread, permalink: undefined };

    const result = await extractEscalationAnalysis(parseFn, "claude-haiku-4-5", threadWithoutPermalink);
    expect(result.permalink).toBeNull();
  });
});

describe("extractEscalationAnalysis — non-technical invariant", () => {
  it("nulls normalizedProblemStatement when the model marks a thread non-technical but still writes one", async () => {
    const parseFn = makeParseFn({
      parsed_output: {
        ...validAnalysis,
        isTechnicalEscalation: false,
        classification: "access_request",
        normalizedProblemStatement: "User requests Stripe dashboard access",
        affectedSystem: "stripe",
        issueTypeHint: "access",
      },
      stop_reason: "end_turn",
    });

    const result = await extractEscalationAnalysis(parseFn, "claude-haiku-4-5", thread);

    expect(result.isTechnicalEscalation).toBe(false);
    expect(result.normalizedProblemStatement).toBeNull();
    // Non-embedded metadata is intentionally preserved.
    expect(result.affectedSystem).toBe("stripe");
    expect(result.issueTypeHint).toBe("access");
  });

  it("keeps normalizedProblemStatement for genuine technical escalations", async () => {
    const parseFn = makeParseFn({ parsed_output: validAnalysis, stop_reason: "end_turn" });

    const result = await extractEscalationAnalysis(parseFn, "claude-haiku-4-5", thread);

    expect(result.isTechnicalEscalation).toBe(true);
    expect(result.normalizedProblemStatement).toBe("Bulk vehicle upload fails for large batches");
  });
});

describe("extractEscalationAnalysis — malformed response handling", () => {
  it("throws ExtractionParseError when parsed_output is null", async () => {
    const parseFn = makeParseFn({ parsed_output: null, stop_reason: "max_tokens" });

    await expect(extractEscalationAnalysis(parseFn, "claude-haiku-4-5", thread)).rejects.toThrow(ExtractionParseError);
  });

  it("throws ExtractionRefusedError when stop_reason is refusal", async () => {
    const parseFn = makeParseFn({ parsed_output: null, stop_reason: "refusal" });

    await expect(extractEscalationAnalysis(parseFn, "claude-haiku-4-5", thread)).rejects.toThrow(
      ExtractionRefusedError,
    );
  });

  it("does not retry a malformed-response failure", async () => {
    const parseFn = makeParseFn({ parsed_output: null, stop_reason: "max_tokens" });

    await expect(extractEscalationAnalysis(parseFn, "claude-haiku-4-5", thread, undefined, noSleep)).rejects.toThrow();
    expect(parseFn).toHaveBeenCalledTimes(1);
  });
});

describe("extractEscalationAnalysis — retry behavior", () => {
  it("retries a rate-limited request and succeeds within the bound", async () => {
    let calls = 0;
    const rateLimitError = new Anthropic.RateLimitError(
      429,
      { error: { type: "rate_limit_error", message: "slow down" } },
      "slow down",
      new Headers(),
    );

    const parseFn: EscalationParseFn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        throw rateLimitError;
      }
      return { parsed_output: validAnalysis, stop_reason: "end_turn" };
    });

    const result = await extractEscalationAnalysis(
      parseFn,
      "claude-haiku-4-5",
      thread,
      { maxAttempts: 3, baseDelayMs: 1 },
      noSleep,
    );

    expect(result.classification).toBe("technical_defect");
    expect(parseFn).toHaveBeenCalledTimes(3);
  });

  it("stops after the bounded number of attempts and does not retry indefinitely", async () => {
    const rateLimitError = new Anthropic.RateLimitError(
      429,
      { error: { type: "rate_limit_error", message: "slow down" } },
      "slow down",
      new Headers(),
    );
    const parseFn: EscalationParseFn = vi.fn(async () => {
      throw rateLimitError;
    });

    await expect(
      extractEscalationAnalysis(parseFn, "claude-haiku-4-5", thread, { maxAttempts: 3, baseDelayMs: 1 }, noSleep),
    ).rejects.toThrow();
    expect(parseFn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-retryable error (e.g. bad request)", async () => {
    const badRequestError = new Anthropic.BadRequestError(
      400,
      { error: { type: "invalid_request_error", message: "bad input" } },
      "bad input",
      new Headers(),
    );
    const parseFn: EscalationParseFn = vi.fn(async () => {
      throw badRequestError;
    });

    await expect(
      extractEscalationAnalysis(parseFn, "claude-haiku-4-5", thread, { maxAttempts: 3, baseDelayMs: 1 }, noSleep),
    ).rejects.toThrow(Anthropic.BadRequestError);
    expect(parseFn).toHaveBeenCalledTimes(1);
  });
});
