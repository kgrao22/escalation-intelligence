import { describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import {
  adjudicatePair,
  AdjudicationParseError,
  AdjudicationRefusedError,
  type AdjudicationParseFn,
} from "../../src/adjudication/adjudicatePair.js";
import type { CandidatePair } from "../../src/adjudication/candidatePairs.js";
import type { RecurrenceAdjudicationLLMOutput } from "../../src/llm/schemas/recurrenceAdjudication.js";

const candidate: CandidatePair = {
  pairId: "1.0::2.0",
  similarity: 0.88,
  a: {
    rootTs: "1.0",
    permalink: "https://slack/1",
    normalizedProblemStatement: "Invoice GST excludes broker fees",
    classification: "technical_defect",
    affectedSystem: "billing",
    issueTypeHint: "calculation",
    suspectedRootCause: "GST applied before fee components are added",
    rootCauseConfidence: 0.8,
    resolutionStatus: "resolved",
    resolutionSummary: "Recalculated GST after fees",
  },
  b: {
    rootTs: "2.0",
    permalink: "https://slack/2",
    normalizedProblemStatement: "Invoice total omits GST for certain fee types",
    classification: "technical_defect",
    affectedSystem: "billing",
    issueTypeHint: "calculation",
    suspectedRootCause: null,
    rootCauseConfidence: null,
    resolutionStatus: "unresolved",
    resolutionSummary: null,
  },
};

const sameVerdict: RecurrenceAdjudicationLLMOutput = {
  relationship: "same_underlying_issue",
  confidence: 0.9,
  reasoning: "Both describe GST omitted from fee components.",
  proposedRecurringIssueName: "Incorrect GST calculation on invoice fee components",
};

const noSleep = () => Promise.resolve();

function parseFnReturning(output: RecurrenceAdjudicationLLMOutput | null, stopReason = "end_turn"): AdjudicationParseFn {
  return vi.fn(async () => ({ parsed_output: output, stop_reason: stopReason }));
}

describe("adjudicatePair — prompt construction", () => {
  it("supplies root-cause and resolution evidence for both sides", async () => {
    const parseFn = parseFnReturning(sameVerdict);
    await adjudicatePair(parseFn, "claude-haiku-4-5", candidate);

    const prompt = vi.mocked(parseFn).mock.calls[0]?.[0].userPrompt ?? "";
    expect(prompt).toContain("GST applied before fee components are added");
    expect(prompt).toContain("root cause confidence: 0.8");
    expect(prompt).toContain("Recalculated GST after fees");
    expect(prompt).toContain("affected system: billing");
  });

  it("marks absent evidence as not established rather than omitting it", async () => {
    const parseFn = parseFnReturning(sameVerdict);
    await adjudicatePair(parseFn, "claude-haiku-4-5", candidate);

    const prompt = vi.mocked(parseFn).mock.calls[0]?.[0].userPrompt ?? "";
    expect(prompt).toContain("suspected root cause: (not established)");
  });

  it("includes both normalized problem statements", async () => {
    const parseFn = parseFnReturning(sameVerdict);
    await adjudicatePair(parseFn, "claude-haiku-4-5", candidate);

    const prompt = vi.mocked(parseFn).mock.calls[0]?.[0].userPrompt ?? "";
    expect(prompt).toContain("Invoice GST excludes broker fees");
    expect(prompt).toContain("Invoice total omits GST for certain fee types");
  });

  it("sends the conservative adjudication system prompt and the requested model", async () => {
    const parseFn = parseFnReturning(sameVerdict);
    await adjudicatePair(parseFn, "claude-sonnet-5", candidate);

    const call = vi.mocked(parseFn).mock.calls[0]?.[0];
    expect(call?.model).toBe("claude-sonnet-5");
    expect(call?.systemPrompt).toContain("BE CONSERVATIVE");
    expect(call?.systemPrompt).toContain("ROOT CAUSE EVIDENCE IS DECISIVE");
  });

  it("never sends raw Slack thread text", async () => {
    const parseFn = parseFnReturning(sameVerdict);
    await adjudicatePair(parseFn, "claude-haiku-4-5", candidate);

    const prompt = vi.mocked(parseFn).mock.calls[0]?.[0].userPrompt ?? "";
    expect(prompt).not.toContain("ROOT MESSAGE:");
    expect(prompt).not.toContain("REPLY 1:");
  });
});

describe("adjudicatePair — relationship handling", () => {
  it("returns the verdict with pairId and similarity attached locally", async () => {
    const result = await adjudicatePair(parseFnReturning(sameVerdict), "claude-haiku-4-5", candidate);

    expect(result.pairId).toBe("1.0::2.0");
    expect(result.similarity).toBeCloseTo(0.88, 10);
    expect(result.relationship).toBe("same_underlying_issue");
  });

  it("keeps the proposed issue name for a SAME verdict", async () => {
    const result = await adjudicatePair(parseFnReturning(sameVerdict), "claude-haiku-4-5", candidate);
    expect(result.proposedName).toBe("Incorrect GST calculation on invoice fee components");
  });

  it("strips an issue name from a RELATED verdict", async () => {
    const parseFn = parseFnReturning({
      relationship: "related_problem_family",
      confidence: 0.6,
      reasoning: "Same workflow, different causes.",
      proposedRecurringIssueName: "Payment link failures",
    });

    const result = await adjudicatePair(parseFn, "claude-haiku-4-5", candidate);
    expect(result.relationship).toBe("related_problem_family");
    expect(result.proposedName).toBeNull();
  });

  it("strips an issue name from a DIFFERENT verdict", async () => {
    const parseFn = parseFnReturning({
      relationship: "different",
      confidence: 0.8,
      reasoning: "Unrelated.",
      proposedRecurringIssueName: "Something",
    });

    const result = await adjudicatePair(parseFn, "claude-haiku-4-5", candidate);
    expect(result.proposedName).toBeNull();
  });
});

describe("adjudicatePair — malformed responses", () => {
  it("throws AdjudicationParseError when parsed_output is null", async () => {
    await expect(
      adjudicatePair(parseFnReturning(null, "max_tokens"), "claude-haiku-4-5", candidate),
    ).rejects.toThrow(AdjudicationParseError);
  });

  it("throws AdjudicationRefusedError on a refusal", async () => {
    await expect(
      adjudicatePair(parseFnReturning(null, "refusal"), "claude-haiku-4-5", candidate),
    ).rejects.toThrow(AdjudicationRefusedError);
  });

  it("does not retry a malformed response", async () => {
    const parseFn = parseFnReturning(null, "max_tokens");
    await expect(
      adjudicatePair(parseFn, "claude-haiku-4-5", candidate, undefined, noSleep),
    ).rejects.toThrow();
    expect(parseFn).toHaveBeenCalledTimes(1);
  });
});

describe("adjudicatePair — bounded retry", () => {
  const rateLimit = () =>
    new Anthropic.RateLimitError(
      429,
      { error: { type: "rate_limit_error", message: "slow down" } },
      "slow down",
      new Headers(),
    );

  it("retries a rate-limited call and succeeds within the bound", async () => {
    let calls = 0;
    const parseFn: AdjudicationParseFn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        throw rateLimit();
      }
      return { parsed_output: sameVerdict, stop_reason: "end_turn" };
    });

    const result = await adjudicatePair(
      parseFn,
      "claude-haiku-4-5",
      candidate,
      { maxAttempts: 3, baseDelayMs: 1 },
      noSleep,
    );

    expect(result.relationship).toBe("same_underlying_issue");
    expect(parseFn).toHaveBeenCalledTimes(3);
  });

  it("stops after the bounded attempt count rather than retrying forever", async () => {
    const parseFn: AdjudicationParseFn = vi.fn(async () => {
      throw rateLimit();
    });

    await expect(
      adjudicatePair(parseFn, "claude-haiku-4-5", candidate, { maxAttempts: 3, baseDelayMs: 1 }, noSleep),
    ).rejects.toThrow();
    expect(parseFn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-retryable error", async () => {
    const parseFn: AdjudicationParseFn = vi.fn(async () => {
      throw new Anthropic.BadRequestError(
        400,
        { error: { type: "invalid_request_error", message: "bad" } },
        "bad",
        new Headers(),
      );
    });

    await expect(
      adjudicatePair(parseFn, "claude-haiku-4-5", candidate, { maxAttempts: 3, baseDelayMs: 1 }, noSleep),
    ).rejects.toThrow(Anthropic.BadRequestError);
    expect(parseFn).toHaveBeenCalledTimes(1);
  });
});
