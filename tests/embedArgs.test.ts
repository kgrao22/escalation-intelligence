import { describe, expect, it } from "vitest";
import { parseEmbedArgs } from "../src/cli/embedArgs.js";

describe("parseEmbedArgs", () => {
  it("defaults dryRun to false", () => {
    expect(parseEmbedArgs([])).toEqual({ input: undefined, dryRun: false, category: "technical" });
  });

  it("parses --dry-run", () => {
    expect(parseEmbedArgs(["--dry-run"])).toEqual({ input: undefined, dryRun: true, category: "technical" });
  });

  it("ignores unrelated flags", () => {
    expect(parseEmbedArgs(["--verbose"])).toEqual({ input: undefined, dryRun: false, category: "technical" });
  });
});
