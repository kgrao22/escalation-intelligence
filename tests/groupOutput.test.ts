import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { groupOutputFilePath, writeGroupOutput, type GroupOutput } from "../src/persistence/groupOutput.js";
import { parseGroupsArgs } from "../src/cli/groupsArgs.js";

const createdAt = new Date("2026-08-10T09:00:00.000Z");

function makeOutput(): GroupOutput {
  return {
    metadata: {
      adjudicationInputFile: "data/intelligence/adjudications-90d-2026-08-10.json",
      extractionInputFile: "data/intelligence/extractions-90d-2026-08-09.json",
      sourceWindowDays: 90,
      createdAt: createdAt.toISOString(),
      adjudicationModel: "claude-haiku-4-5",
      adjudicationPromptVersion: "v1",
      candidateSimilarityFloor: 0.6,
      adjudicatedPairs: 58,
      sameEdges: 9,
      relatedEdges: 37,
      differentEdges: 12,
      candidateComponents: 7,
      recurringGroups: 7,
      conflictedComponents: 0,
      overlappingGroups: 0,
      overlappingMembers: [],
      relatedPairCount: 37,
    },
    groups: [
      {
        groupId: "grp_abc123456789",
        name: "Policy cancellation status not synchronized across systems",
        alternateNames: ["Policy cancellation state not fully synchronized"],
        members: [
          {
            rootTs: "1781246131.192699",
            normalizedProblemStatement: "Statement A",
            permalink: "https://slack/a",
            postedAt: "2026-06-08T00:00:00.000Z",
            classification: "technical_defect",
            affectedSystem: "policy",
            severity: "high",
            customerImpact: "multiple_customers",
            suspectedRootCause: "State not propagated",
            resolutionStatus: "resolved",
            resolutionSummary: "Backfilled",
          },
        ],
        occurrenceCount: 3,
        firstSeen: "2026-06-08T00:00:00.000Z",
        lastSeen: "2026-07-30T00:00:00.000Z",
        averageSameEdgeConfidence: 0.85,
        minimumSameEdgeConfidence: 0.82,
        averageSameEdgeSimilarity: 0.71,
        minimumSameEdgeSimilarity: 0.619,
        consistency: "fully_confirmed",
        splitFromConflictedComponent: false,
        sameEdges: ["a::b", "b::c", "a::c"],
        relatedEdgesInsideGroup: [],
        differentEdgesInsideGroup: [],
        unadjudicatedPairsInsideGroup: [],
      },
    ],
  };
}

describe("groupOutputFilePath", () => {
  it("includes the window tag and date", () => {
    expect(groupOutputFilePath("/d", createdAt, "90d")).toBe(path.join("/d", "groups-90d-2026-08-10.json"));
  });

  it("does not collide across windows on the same day", () => {
    expect(groupOutputFilePath("/d", createdAt, "30d")).not.toBe(groupOutputFilePath("/d", createdAt, "90d"));
  });
});

describe("writeGroupOutput", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  it("writes valid JSON preserving every documented field", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "escalation-intelligence-groups-test-"));
    const filePath = groupOutputFilePath(dir, createdAt, "90d");
    const value = makeOutput();

    await writeGroupOutput(value, filePath);
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as GroupOutput;

    expect(parsed).toEqual(value);
    expect(Object.keys(parsed).sort()).toEqual(["groups", "metadata"]);
    expect(parsed.metadata.relatedPairCount).toBe(37);
    expect(parsed.groups[0]?.occurrenceCount).toBe(3);
    expect(parsed.groups[0]?.members[0]?.permalink).toBe("https://slack/a");
  });
});

describe("parseGroupsArgs", () => {
  it("defaults to auto-selected inputs and dryRun false", () => {
    expect(parseGroupsArgs([])).toEqual({ input: undefined, extractions: undefined, dryRun: false, category: "technical" });
  });

  it("parses explicit --input and --extractions", () => {
    expect(
      parseGroupsArgs([
        "--input=data/intelligence/adjudications-90d-2026-08-10.json",
        "--extractions=data/intelligence/extractions-90d-2026-08-09.json",
      ]),
    ).toEqual({
      input: "data/intelligence/adjudications-90d-2026-08-10.json",
      extractions: "data/intelligence/extractions-90d-2026-08-09.json",
      dryRun: false, category: "technical"
    });
  });

  it("parses --dry-run", () => {
    expect(parseGroupsArgs(["--dry-run"]).dryRun).toBe(true);
  });
});

describe("grouping has no API dependency", () => {
  const sourceFiles = [
    "src/groups/buildGroups.ts",
    "src/groups/graph.ts",
    "src/groups/relationshipMatrix.ts",
    "src/cli/intelligence-groups.ts",
    "src/persistence/groupOutput.ts",
  ];

  it.each(sourceFiles)("%s imports no API client and makes no network call", async (relativePath) => {
    const source = await readFile(path.resolve(process.cwd(), relativePath), "utf8");
    for (const marker of ["@anthropic-ai/sdk", "@slack/web-api", "voyageClient", "api.voyageai.com", "API_KEY"]) {
      expect(source).not.toContain(marker);
    }
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });
});
