import { describe, expect, it } from "vitest";
import { parseAdjudicateArgs } from "../src/cli/adjudicateArgs.js";
import { DEFAULT_RECURRENCE_CANDIDATE_SIMILARITY, parseEnv } from "../src/config/env.js";

const validSource = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_SOURCE_CHANNEL_ID: "C0SOURCE0000",
  SLACK_DEST_CHANNEL_ID: "C0DEST00000",
};

describe("parseAdjudicateArgs", () => {
  it("defaults to auto-selected inputs, no limit, no floor override, dryRun false", () => {
    expect(parseAdjudicateArgs([])).toEqual({
      embeddings: undefined,
      extractions: undefined,
      limit: undefined,
      floor: undefined,
      dryRun: false, category: "technical"
    });
  });

  it("parses explicit --embeddings and --extractions", () => {
    const args = parseAdjudicateArgs([
      "--embeddings=data/intelligence/embeddings-90d-2026-08-09.json",
      "--extractions=data/intelligence/extractions-90d-2026-08-09.json",
    ]);
    expect(args.embeddings).toBe("data/intelligence/embeddings-90d-2026-08-09.json");
    expect(args.extractions).toBe("data/intelligence/extractions-90d-2026-08-09.json");
  });

  it("parses --limit and --dry-run", () => {
    expect(parseAdjudicateArgs(["--limit=10", "--dry-run"])).toMatchObject({ limit: 10, dryRun: true });
  });

  it("parses a --floor override", () => {
    expect(parseAdjudicateArgs(["--floor=0.7"]).floor).toBeCloseTo(0.7, 10);
  });

  it("rejects an invalid --limit", () => {
    expect(() => parseAdjudicateArgs(["--limit=abc"])).toThrow(/Invalid --limit value/);
    expect(() => parseAdjudicateArgs(["--limit=0"])).toThrow(/Invalid --limit value/);
  });

  it("rejects a --floor outside the cosine similarity range", () => {
    expect(() => parseAdjudicateArgs(["--floor=1.5"])).toThrow(/Invalid --floor value/);
    expect(() => parseAdjudicateArgs(["--floor=-2"])).toThrow(/Invalid --floor value/);
    expect(() => parseAdjudicateArgs(["--floor=abc"])).toThrow(/Invalid --floor value/);
  });
});

describe("RECURRENCE_CANDIDATE_SIMILARITY env config", () => {
  it("defaults the candidate floor to 0.60", () => {
    expect(DEFAULT_RECURRENCE_CANDIDATE_SIMILARITY).toBe(0.6);
    expect(parseEnv(validSource).RECURRENCE_CANDIDATE_SIMILARITY).toBe(0.6);
  });

  it("is configurable via the environment", () => {
    expect(parseEnv({ ...validSource, RECURRENCE_CANDIDATE_SIMILARITY: "0.7" }).RECURRENCE_CANDIDATE_SIMILARITY).toBe(
      0.7,
    );
  });

  it("rejects a floor outside the cosine similarity range", () => {
    expect(() => parseEnv({ ...validSource, RECURRENCE_CANDIDATE_SIMILARITY: "1.5" })).toThrow();
  });
});
