import { describe, expect, it, vi } from "vitest";
import type { AdjudicationParseFn } from "../../src/adjudication/adjudicatePair.js";
import type { CandidatePair } from "../../src/adjudication/candidatePairs.js";
import {
  limitCandidates,
  runAdjudication,
  type AdjudicationProgressEvent,
} from "../../src/adjudication/runAdjudication.js";
import type { AdjudicationResultItem } from "../../src/persistence/adjudicationOutput.js";

function candidate(id: string, similarity = 0.7): CandidatePair {
  return {
    pairId: id,
    similarity,
    a: {
      rootTs: `${id}-a`,
      permalink: `https://slack/${id}-a`,
      normalizedProblemStatement: `statement ${id} a`,
      classification: "technical_defect",
      affectedSystem: null,
      issueTypeHint: null,
      suspectedRootCause: null,
      rootCauseConfidence: null,
      resolutionStatus: null,
      resolutionSummary: null,
    },
    b: {
      rootTs: `${id}-b`,
      permalink: `https://slack/${id}-b`,
      normalizedProblemStatement: `statement ${id} b`,
      classification: "technical_defect",
      affectedSystem: null,
      issueTypeHint: null,
      suspectedRootCause: null,
      rootCauseConfidence: null,
      resolutionStatus: null,
      resolutionSummary: null,
    },
  };
}

const differentVerdict: AdjudicationParseFn = async () => ({
  parsed_output: {
    relationship: "different",
    confidence: 0.7,
    reasoning: "Unrelated.",
    proposedRecurringIssueName: null,
  },
  stop_reason: "end_turn",
});

describe("limitCandidates", () => {
  const candidates = [candidate("1"), candidate("2"), candidate("3")];

  it("returns all candidates when no limit is given", () => {
    expect(limitCandidates(candidates)).toHaveLength(3);
  });

  it("slices to the first N candidates", () => {
    expect(limitCandidates(candidates, 2).map((c) => c.pairId)).toEqual(["1", "2"]);
  });

  it("returns everything when the limit exceeds the candidate count", () => {
    expect(limitCandidates(candidates, 10)).toHaveLength(3);
  });
});

describe("runAdjudication", () => {
  it("adjudicates each candidate and records the verdict", async () => {
    const parseFn = vi.fn(differentVerdict);
    const results = await runAdjudication({
      candidates: [candidate("1"), candidate("2")],
      parseFn,
      model: "claude-haiku-4-5",
      promptVersion: "v1",
      priorIndex: new Map(),
    });

    expect(parseFn).toHaveBeenCalledTimes(2);
    expect(results.every((r) => r.status === "success")).toBe(true);
    expect(results[0]?.relationship).toBe("different");
  });

  it("retains both sides' rootTs, statements, and permalinks on each result", async () => {
    const [result] = await runAdjudication({
      candidates: [candidate("1", 0.83)],
      parseFn: differentVerdict,
      model: "claude-haiku-4-5",
      promptVersion: "v1",
      priorIndex: new Map(),
    });

    expect(result?.similarity).toBeCloseTo(0.83, 10);
    expect(result?.a.rootTs).toBe("1-a");
    expect(result?.b.permalink).toBe("https://slack/1-b");
    expect(result?.a.normalizedProblemStatement).toBe("statement 1 a");
  });

  it("reuses a cached prior adjudication without calling the LLM", async () => {
    const parseFn = vi.fn(differentVerdict);
    const cached: AdjudicationResultItem = {
      pairId: "1",
      similarity: 0.7,
      a: { rootTs: "1-a", normalizedProblemStatement: "x", permalink: null },
      b: { rootTs: "1-b", normalizedProblemStatement: "y", permalink: null },
      status: "success",
      relationship: "same_underlying_issue",
      confidence: 0.9,
      reasoning: "cached",
      proposedRecurringIssueName: "Cached issue",
    };

    const events: AdjudicationProgressEvent[] = [];
    const results = await runAdjudication({
      candidates: [candidate("1")],
      parseFn,
      model: "claude-haiku-4-5",
      promptVersion: "v1",
      priorIndex: new Map([["1::v1::claude-haiku-4-5", cached]]),
      onProgress: (e) => events.push(e),
    });

    expect(parseFn).not.toHaveBeenCalled();
    expect(results).toEqual([cached]);
    expect(events[0]?.outcome).toBe("cached");
  });

  it("does not reuse a cached result from a different prompt version or model", async () => {
    const parseFn = vi.fn(differentVerdict);
    const cached: AdjudicationResultItem = {
      pairId: "1",
      similarity: 0.7,
      a: { rootTs: "1-a", normalizedProblemStatement: "x", permalink: null },
      b: { rootTs: "1-b", normalizedProblemStatement: "y", permalink: null },
      status: "success",
      relationship: "same_underlying_issue",
      confidence: 0.9,
      reasoning: "cached",
      proposedRecurringIssueName: "Cached issue",
    };

    await runAdjudication({
      candidates: [candidate("1")],
      parseFn,
      model: "claude-haiku-4-5",
      promptVersion: "v2",
      priorIndex: new Map([["1::v1::claude-haiku-4-5", cached]]),
    });

    expect(parseFn).toHaveBeenCalledTimes(1);
  });

  it("records a failure and keeps processing the remaining candidates", async () => {
    let call = 0;
    const parseFn: AdjudicationParseFn = vi.fn(async () => {
      call += 1;
      if (call === 2) {
        throw new Error("boom");
      }
      return {
        parsed_output: {
          relationship: "different" as const,
          confidence: 0.5,
          reasoning: "n/a",
          proposedRecurringIssueName: null,
        },
        stop_reason: "end_turn",
      };
    });

    const results = await runAdjudication({
      candidates: [candidate("1"), candidate("2"), candidate("3")],
      parseFn,
      model: "claude-haiku-4-5",
      promptVersion: "v1",
      priorIndex: new Map(),
      sleep: () => Promise.resolve(),
    });

    expect(results).toHaveLength(3);
    expect(results[1]?.status).toBe("failed");
    expect(results[1]?.error).toContain("boom");
    expect(results[2]?.status).toBe("success");
  });

  it("adjudicates every candidate uniformly, with no high-similarity shortcut", async () => {
    const parseFn = vi.fn(differentVerdict);
    await runAdjudication({
      candidates: [candidate("1", 0.99), candidate("2", 0.61)],
      parseFn,
      model: "claude-haiku-4-5",
      promptVersion: "v1",
      priorIndex: new Map(),
    });

    // A 0.99 pair is still sent to the model rather than auto-labelled SAME.
    expect(parseFn).toHaveBeenCalledTimes(2);
  });
});
