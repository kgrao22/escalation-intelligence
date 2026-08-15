import { describe, expect, it } from "vitest";
import { parseExtractArgs } from "../src/cli/extractArgs.js";

describe("parseExtractArgs", () => {
  it("defaults to no input, no limit, and dryRun false", () => {
    expect(parseExtractArgs([])).toEqual({ input: undefined, limit: undefined, dryRun: false, retryFailed: false });
  });

  it("parses --input=path", () => {
    const args = parseExtractArgs(["--input=data/slack/escalations-2026-08-09.json"]);
    expect(args.input).toBe("data/slack/escalations-2026-08-09.json");
  });

  it("parses --limit=N", () => {
    expect(parseExtractArgs(["--limit=5"]).limit).toBe(5);
  });

  it("parses --dry-run", () => {
    expect(parseExtractArgs(["--dry-run"]).dryRun).toBe(true);
  });

  it("combines flags", () => {
    const args = parseExtractArgs(["--input=x.json", "--limit=5", "--dry-run"]);
    expect(args).toEqual({ input: "x.json", limit: 5, dryRun: true, retryFailed: false });
  });

  it("throws for a non-numeric --limit value", () => {
    expect(() => parseExtractArgs(["--limit=abc"])).toThrow(/Invalid --limit value/);
  });

  it("throws for a zero or negative --limit value", () => {
    expect(() => parseExtractArgs(["--limit=0"])).toThrow(/Invalid --limit value/);
    expect(() => parseExtractArgs(["--limit=-5"])).toThrow(/Invalid --limit value/);
  });
});
