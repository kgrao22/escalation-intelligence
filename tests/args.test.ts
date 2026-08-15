import { describe, expect, it } from "vitest";
import { resolveDaysBack } from "../src/cli/args.js";

describe("resolveDaysBack", () => {
  it("falls back to the env default when --days is not supplied", () => {
    expect(resolveDaysBack([], 30)).toBe(30);
  });

  it("parses --days=N", () => {
    expect(resolveDaysBack(["--days=90"], 30)).toBe(90);
  });

  it("parses --days N (space-separated)", () => {
    expect(resolveDaysBack(["--days", "7"], 30)).toBe(7);
  });

  it("throws for a non-numeric --days value", () => {
    expect(() => resolveDaysBack(["--days=abc"], 30)).toThrow(/Invalid --days value/);
  });

  it("throws for a zero or negative --days value", () => {
    expect(() => resolveDaysBack(["--days=0"], 30)).toThrow(/Invalid --days value/);
    expect(() => resolveDaysBack(["--days=-5"], 30)).toThrow(/Invalid --days value/);
  });
});
