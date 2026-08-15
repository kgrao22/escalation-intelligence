import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseReviewArgs } from "../src/cli/reviewArgs.js";

describe("parseReviewArgs", () => {
  it("defaults to no explicit input and no per-bucket override", () => {
    expect(parseReviewArgs([])).toEqual({ input: undefined, maxPerBucket: undefined });
  });

  it("parses --input", () => {
    expect(parseReviewArgs(["--input=data/intelligence/embeddings-90d-2026-08-09.json"]).input).toBe(
      "data/intelligence/embeddings-90d-2026-08-09.json",
    );
  });

  it("parses --per-bucket", () => {
    expect(parseReviewArgs(["--per-bucket=20"]).maxPerBucket).toBe(20);
  });

  it("combines flags", () => {
    expect(parseReviewArgs(["--input=x.json", "--per-bucket=5"])).toEqual({ input: "x.json", maxPerBucket: 5 });
  });

  it("rejects an invalid --per-bucket value", () => {
    expect(() => parseReviewArgs(["--per-bucket=abc"])).toThrow(/Invalid --per-bucket value/);
    expect(() => parseReviewArgs(["--per-bucket=0"])).toThrow(/Invalid --per-bucket value/);
    expect(() => parseReviewArgs(["--per-bucket=-3"])).toThrow(/Invalid --per-bucket value/);
  });
});

/**
 * The review step must be free to run: it prepares evidence from data already
 * on disk. These assertions are static rather than behavioural because the
 * guarantee worth protecting is that the code *cannot* reach a paid API, not
 * merely that it didn't on one particular run.
 */
describe("review pipeline has no API dependency", () => {
  const sourceFiles = [
    "src/cli/intelligence-review.ts",
    "src/cli/reviewArgs.ts",
    "src/review/selectReviewPairs.ts",
    "src/persistence/reviewOutput.ts",
  ];

  const forbidden = [
    "@anthropic-ai/sdk",
    "@slack/web-api",
    "voyageClient",
    "anthropicParseClient",
    "api.voyageai.com",
    "slack.com/api",
    "requireAnthropicApiKey",
    "requireVoyageApiKey",
  ];

  it.each(sourceFiles)("%s imports no API client or endpoint", async (relativePath) => {
    const source = await readFile(path.resolve(process.cwd(), relativePath), "utf8");
    for (const marker of forbidden) {
      expect(source).not.toContain(marker);
    }
  });

  it.each(sourceFiles)("%s performs no network call", async (relativePath) => {
    const source = await readFile(path.resolve(process.cwd(), relativePath), "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bhttps?:\/\/(?!slack\/)/);
  });

  it("does not read any API key from the environment", async () => {
    for (const relativePath of sourceFiles) {
      const source = await readFile(path.resolve(process.cwd(), relativePath), "utf8");
      expect(source).not.toContain("API_KEY");
      expect(source).not.toContain("getEnv");
    }
  });

  it("does not implement clustering or select a threshold", async () => {
    for (const relativePath of sourceFiles) {
      const source = await readFile(path.resolve(process.cwd(), relativePath), "utf8");
      expect(source.toLowerCase()).not.toContain("hdbscan");
      expect(source.toLowerCase()).not.toContain("kmeans");
      expect(source.toLowerCase()).not.toContain("k-means");
      expect(source).not.toMatch(/\bcluster(s|ing)?\s*[:=]/i);
      expect(source).not.toMatch(/\bthreshold\s*[:=]/i);
    }
  });
});
