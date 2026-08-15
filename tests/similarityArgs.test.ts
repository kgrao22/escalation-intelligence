import { describe, expect, it } from "vitest";
import { parseSimilarityArgs } from "../src/cli/similarityArgs.js";
import { parseFetchArgs, resolveDaysBack } from "../src/cli/args.js";

describe("parseSimilarityArgs", () => {
  it("defaults to no explicit input", () => {
    expect(parseSimilarityArgs([])).toEqual({ input: undefined });
  });

  it("parses --input", () => {
    expect(parseSimilarityArgs(["--input=data/intelligence/embeddings-90d-2026-08-09.json"]).input).toBe(
      "data/intelligence/embeddings-90d-2026-08-09.json",
    );
  });
});

describe("parseFetchArgs", () => {
  it("falls back to the env default and dryRun false", () => {
    expect(parseFetchArgs([], 30)).toEqual({ daysBack: 30, dryRun: false });
  });

  it("parses --days=90", () => {
    expect(parseFetchArgs(["--days=90"], 30)).toEqual({ daysBack: 90, dryRun: false });
  });

  it("parses --dry-run alongside --days", () => {
    expect(parseFetchArgs(["--days=90", "--dry-run"], 30)).toEqual({ daysBack: 90, dryRun: true });
  });

  it("supports --dry-run on its own", () => {
    expect(parseFetchArgs(["--dry-run"], 30)).toEqual({ daysBack: 30, dryRun: true });
  });

  it("rejects an invalid --days value", () => {
    expect(() => parseFetchArgs(["--days=abc"], 30)).toThrow(/Invalid --days value/);
    expect(() => parseFetchArgs(["--days=0"], 30)).toThrow(/Invalid --days value/);
    expect(() => parseFetchArgs(["--days=-5"], 30)).toThrow(/Invalid --days value/);
  });
});

describe("resolveDaysBack (backward compatible)", () => {
  it("still resolves the day count as before", () => {
    expect(resolveDaysBack([], 30)).toBe(30);
    expect(resolveDaysBack(["--days=90"], 30)).toBe(90);
  });
});
