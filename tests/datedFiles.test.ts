import { describe, expect, it } from "vitest";
import {
  buildDatedFilename,
  listDatedFiles,
  parseDatedFilename,
  pickLatestDatedFilename,
  windowTagForDays,
} from "../src/persistence/datedFiles.js";

const date = new Date("2026-08-09T12:00:00.000Z");

describe("windowTagForDays", () => {
  it("formats a lookback window as a tag", () => {
    expect(windowTagForDays(30)).toBe("30d");
    expect(windowTagForDays(90)).toBe("90d");
  });
});

describe("buildDatedFilename", () => {
  it("builds a window-tagged filename", () => {
    expect(buildDatedFilename("escalations", date, "90d")).toBe("escalations-90d-2026-08-09.json");
  });

  it("omits the tag when none is given, preserving the legacy shape", () => {
    expect(buildDatedFilename("escalations", date)).toBe("escalations-2026-08-09.json");
    expect(buildDatedFilename("escalations", date, null)).toBe("escalations-2026-08-09.json");
  });

  it("produces distinct names for different windows on the same day", () => {
    expect(buildDatedFilename("escalations", date, "30d")).not.toBe(buildDatedFilename("escalations", date, "90d"));
  });

  it("produces distinct names across the whole pipeline for the same window", () => {
    const names = [
      buildDatedFilename("escalations", date, "90d"),
      buildDatedFilename("extractions", date, "90d"),
      buildDatedFilename("embeddings", date, "90d"),
    ];
    expect(new Set(names).size).toBe(3);
    expect(names).toEqual([
      "escalations-90d-2026-08-09.json",
      "extractions-90d-2026-08-09.json",
      "embeddings-90d-2026-08-09.json",
    ]);
  });
});

describe("parseDatedFilename", () => {
  it("parses a window-tagged filename", () => {
    expect(parseDatedFilename("escalations-90d-2026-08-09.json", "escalations")).toEqual({
      filename: "escalations-90d-2026-08-09.json",
      prefix: "escalations",
      windowTag: "90d",
      generation: 1,
      date: "2026-08-09",
    });
  });

  it("parses a legacy untagged filename with a null window tag", () => {
    expect(parseDatedFilename("escalations-2026-08-09.json", "escalations")?.windowTag).toBeNull();
  });

  it("rejects a different prefix", () => {
    expect(parseDatedFilename("embeddings-2026-08-09.json", "escalations")).toBeNull();
  });

  it("rejects hand-made backup variants", () => {
    expect(parseDatedFilename("extractions-2026-08-09.v1.json", "extractions")).toBeNull();
  });

  it("rejects a malformed window tag that could be confused with the date", () => {
    expect(parseDatedFilename("escalations-abc-2026-08-09.json", "escalations")).toBeNull();
  });
});

describe("listDatedFiles", () => {
  it("returns matching files oldest first, mixing tagged and untagged", () => {
    const files = [
      "escalations-90d-2026-08-09.json",
      "escalations-2026-07-01.json",
      "escalations-30d-2026-08-01.json",
      "README.md",
    ];
    expect(listDatedFiles(files, "escalations").map((f) => f.filename)).toEqual([
      "escalations-2026-07-01.json",
      "escalations-30d-2026-08-01.json",
      "escalations-90d-2026-08-09.json",
    ]);
  });

  it("orders same-date files deterministically", () => {
    const files = ["escalations-90d-2026-08-09.json", "escalations-30d-2026-08-09.json"];
    const forward = listDatedFiles(files, "escalations").map((f) => f.filename);
    const reversed = listDatedFiles([...files].reverse(), "escalations").map((f) => f.filename);
    expect(forward).toEqual(reversed);
  });
});

describe("pickLatestDatedFilename", () => {
  it("still picks the newest file (backward compatible)", () => {
    const files = ["extractions-2026-08-01.json", "extractions-2026-08-09.json", "extractions-2026-07-15.json"];
    expect(pickLatestDatedFilename(files, "extractions")).toBe("extractions-2026-08-09.json");
  });

  it("prefers a later date over a larger window tag", () => {
    const files = ["escalations-90d-2026-08-01.json", "escalations-30d-2026-08-09.json"];
    expect(pickLatestDatedFilename(files, "escalations")).toBe("escalations-30d-2026-08-09.json");
  });

  it("returns null when nothing matches", () => {
    expect(pickLatestDatedFilename(["README.md"], "extractions")).toBeNull();
    expect(pickLatestDatedFilename([], "extractions")).toBeNull();
  });
});

/**
 * A stage can be re-run with an improved algorithm over the same inputs, e.g.
 * `report-365d-v2-2026-08-14.json`. Before generations were understood, that
 * filename simply did not parse, so prefix resolution silently fell back to the
 * superseded unversioned artifact.
 */
describe("versioned (generation) filenames", () => {
  it("parses a v2 filename and records its generation", () => {
    expect(parseDatedFilename("report-365d-v2-2026-08-14.json", "report")).toEqual({
      filename: "report-365d-v2-2026-08-14.json",
      prefix: "report",
      windowTag: "365d",
      generation: 2,
      date: "2026-08-14",
    });
  });

  it("treats an unversioned filename as generation 1", () => {
    expect(parseDatedFilename("report-365d-2026-08-14.json", "report")?.generation).toBe(1);
  });

  it("parses a versioned filename with no window tag", () => {
    expect(parseDatedFilename("report-v3-2026-08-14.json", "report")).toMatchObject({
      windowTag: null,
      generation: 3,
    });
  });

  it("PREFERS v2 over v1 for the same window and date", () => {
    const files = ["report-365d-2026-08-14.json", "report-365d-v2-2026-08-14.json"];
    expect(pickLatestDatedFilename(files, "report")).toBe("report-365d-v2-2026-08-14.json");
    // Order of the directory listing must not matter.
    expect(pickLatestDatedFilename([...files].reverse(), "report")).toBe("report-365d-v2-2026-08-14.json");
  });

  it("still prefers a newer date over a higher generation", () => {
    const files = ["report-365d-v2-2026-08-14.json", "report-365d-2026-08-20.json"];
    expect(pickLatestDatedFilename(files, "report")).toBe("report-365d-2026-08-20.json");
  });

  it("picks the highest generation when several exist", () => {
    const files = [
      "workflow-clusters-365d-2026-08-14.json",
      "workflow-clusters-365d-v2-2026-08-14.json",
      "workflow-clusters-365d-v3-2026-08-14.json",
    ];
    expect(pickLatestDatedFilename(files, "workflow-clusters")).toBe("workflow-clusters-365d-v3-2026-08-14.json");
  });

  it("does not disturb 90d or 180d resolution", () => {
    const files = ["report-90d-2026-08-11.json", "report-180d-2026-08-14.json"];
    expect(pickLatestDatedFilename(files, "report")).toBe("report-180d-2026-08-14.json");
  });

  it("keeps prefixes isolated: workflow-clusters never matches clusters", () => {
    expect(parseDatedFilename("workflow-clusters-365d-v2-2026-08-14.json", "clusters")).toBeNull();
  });
});
