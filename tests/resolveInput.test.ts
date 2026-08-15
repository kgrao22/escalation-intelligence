import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeInputSelection,
  InputResolutionError,
  resolveInputFile,
  selectLatestCandidate,
} from "../src/persistence/resolveInput.js";

let dir: string;

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = "";
  }
});

async function makeDirWith(filenames: string[]): Promise<string> {
  dir = await mkdtemp(path.join(tmpdir(), "escalation-intelligence-input-test-"));
  const dataDir = path.join(dir, "data");
  await mkdir(dataDir, { recursive: true });
  for (const filename of filenames) {
    await writeFile(path.join(dataDir, filename), "{}", "utf8");
  }
  return dataDir;
}

describe("selectLatestCandidate", () => {
  it("chooses the newest and reports the others as alternatives", () => {
    const { chosen, alternatives } = selectLatestCandidate(
      ["escalations-30d-2026-08-01.json", "escalations-90d-2026-08-09.json"],
      "escalations",
    );
    expect(chosen?.filename).toBe("escalations-90d-2026-08-09.json");
    expect(alternatives.map((a) => a.filename)).toEqual(["escalations-30d-2026-08-01.json"]);
  });

  it("reports no alternatives when only one candidate exists", () => {
    const { chosen, alternatives } = selectLatestCandidate(["escalations-90d-2026-08-09.json"], "escalations");
    expect(chosen?.filename).toBe("escalations-90d-2026-08-09.json");
    expect(alternatives).toEqual([]);
  });

  it("returns null when nothing matches", () => {
    expect(selectLatestCandidate(["README.md"], "escalations").chosen).toBeNull();
  });
});

describe("resolveInputFile — explicit --input", () => {
  it("uses the explicit path and extracts its window tag", async () => {
    const dataDir = await makeDirWith(["escalations-90d-2026-08-09.json", "escalations-30d-2026-08-01.json"]);

    const resolved = await resolveInputFile({
      explicitInput: path.join(dataDir, "escalations-30d-2026-08-01.json"),
      defaultDir: dataDir,
      prefix: "escalations",
      missingHint: "hint",
    });

    expect(resolved.filename).toBe("escalations-30d-2026-08-01.json");
    expect(resolved.windowTag).toBe("30d");
    expect(resolved.autoSelected).toBe(false);
  });

  it("does not auto-pick the newest when an explicit older file is requested", async () => {
    const dataDir = await makeDirWith(["escalations-90d-2026-08-09.json", "escalations-30d-2026-08-01.json"]);

    const resolved = await resolveInputFile({
      explicitInput: path.join(dataDir, "escalations-30d-2026-08-01.json"),
      defaultDir: dataDir,
      prefix: "escalations",
      missingHint: "hint",
    });

    expect(resolved.filename).not.toBe("escalations-90d-2026-08-09.json");
  });

  it("throws a clear error when the explicit path does not exist", async () => {
    const dataDir = await makeDirWith([]);

    await expect(
      resolveInputFile({
        explicitInput: path.join(dataDir, "nope.json"),
        defaultDir: dataDir,
        prefix: "escalations",
        missingHint: "hint",
      }),
    ).rejects.toThrow(InputResolutionError);
  });

  it("throws when the explicit path is a directory rather than a file", async () => {
    const dataDir = await makeDirWith([]);

    await expect(
      resolveInputFile({
        explicitInput: dataDir,
        defaultDir: dataDir,
        prefix: "escalations",
        missingHint: "hint",
      }),
    ).rejects.toThrow(/not a file/);
  });
});

describe("resolveInputFile — auto-selection", () => {
  it("selects the newest candidate and records the alternatives", async () => {
    const dataDir = await makeDirWith(["escalations-30d-2026-08-01.json", "escalations-90d-2026-08-09.json"]);

    const resolved = await resolveInputFile({
      explicitInput: undefined,
      defaultDir: dataDir,
      prefix: "escalations",
      missingHint: "hint",
    });

    expect(resolved.filename).toBe("escalations-90d-2026-08-09.json");
    expect(resolved.windowTag).toBe("90d");
    expect(resolved.autoSelected).toBe(true);
    expect(resolved.alternatives).toHaveLength(1);
  });

  it("still reads legacy untagged files", async () => {
    const dataDir = await makeDirWith(["escalations-2026-08-09.json"]);

    const resolved = await resolveInputFile({
      explicitInput: undefined,
      defaultDir: dataDir,
      prefix: "escalations",
      missingHint: "hint",
    });

    expect(resolved.filename).toBe("escalations-2026-08-09.json");
    expect(resolved.windowTag).toBeNull();
  });

  it("throws with the supplied hint when the directory has no candidates", async () => {
    const dataDir = await makeDirWith(["README.md"]);

    await expect(
      resolveInputFile({
        explicitInput: undefined,
        defaultDir: dataDir,
        prefix: "escalations",
        missingHint: "Run `npm run slack:fetch -- --days=90` first.",
      }),
    ).rejects.toThrow(/slack:fetch -- --days=90/);
  });
});

describe("describeInputSelection", () => {
  it("warns and lists alternatives when auto-selecting among several datasets", () => {
    const lines = describeInputSelection({
      absolutePath: "/x/escalations-90d-2026-08-09.json",
      relativePath: "data/slack/escalations-90d-2026-08-09.json",
      filename: "escalations-90d-2026-08-09.json",
      windowTag: "90d",
      autoSelected: true,
      alternatives: [
        {
          filename: "escalations-30d-2026-08-01.json",
          prefix: "escalations",
          windowTag: "30d",
          generation: 1,
          date: "2026-08-01",
        },
      ],
    }).join("\n");

    expect(lines).toContain("window: 90d");
    expect(lines).toContain("Auto-selected");
    expect(lines).toContain("escalations-30d-2026-08-01.json");
    expect(lines).toContain("--input");
  });

  it("does not warn when the file was chosen explicitly", () => {
    const lines = describeInputSelection({
      absolutePath: "/x/escalations-90d-2026-08-09.json",
      relativePath: "data/slack/escalations-90d-2026-08-09.json",
      filename: "escalations-90d-2026-08-09.json",
      windowTag: "90d",
      autoSelected: false,
      alternatives: [],
    }).join("\n");

    expect(lines).not.toContain("Auto-selected");
  });

  it("does not warn when it is the only candidate", () => {
    const lines = describeInputSelection({
      absolutePath: "/x/escalations-90d-2026-08-09.json",
      relativePath: "data/slack/escalations-90d-2026-08-09.json",
      filename: "escalations-90d-2026-08-09.json",
      windowTag: "90d",
      autoSelected: true,
      alternatives: [],
    }).join("\n");

    expect(lines).not.toContain("Auto-selected");
  });
});
