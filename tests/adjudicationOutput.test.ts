import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  adjudicationOutputFilePath,
  buildPriorAdjudicationIndex,
  countRelationships,
  emptyRelationshipCounts,
  lookupPriorAdjudication,
  writeAdjudicationOutput,
  type AdjudicationOutput,
  type AdjudicationResultItem,
} from "../src/persistence/adjudicationOutput.js";

const createdAt = new Date("2026-08-10T09:00:00.000Z");

function result(pairId: string, overrides: Partial<AdjudicationResultItem> = {}): AdjudicationResultItem {
  return {
    pairId,
    similarity: 0.85,
    a: { rootTs: `${pairId}-a`, normalizedProblemStatement: "A", permalink: "https://slack/a" },
    b: { rootTs: `${pairId}-b`, normalizedProblemStatement: "B", permalink: "https://slack/b" },
    status: "success",
    relationship: "same_underlying_issue",
    confidence: 0.9,
    reasoning: "Same defect.",
    proposedRecurringIssueName: "Incorrect tax calculation on invoice fee components",
    ...overrides,
  };
}

function output(results: AdjudicationResultItem[], promptVersion = "v1", model = "claude-haiku-4-5"): AdjudicationOutput {
  return {
    metadata: {
      embeddingsInputFile: "data/intelligence/embeddings-90d-2026-08-09.json",
      extractionsInputFile: "data/intelligence/extractions-90d-2026-08-09.json",
      createdAt: createdAt.toISOString(),
      model,
      promptVersion,
      candidateSimilarityFloor: 0.6,
      totalEmbeddingPairs: 2415,
      candidatePairs: 58,
      adjudicated: results.filter((r) => r.status === "success").length,
      failures: results.filter((r) => r.status === "failed").length,
      relationshipCounts: countRelationships(results),
      sourceWindowDays: 90,
    },
    results,
  };
}

describe("adjudicationOutputFilePath", () => {
  it("includes the window tag and date", () => {
    expect(adjudicationOutputFilePath("/d", createdAt, "90d")).toBe(
      path.join("/d", "adjudications-90d-2026-08-10.json"),
    );
  });

  it("does not collide across windows on the same day", () => {
    expect(adjudicationOutputFilePath("/d", createdAt, "30d")).not.toBe(
      adjudicationOutputFilePath("/d", createdAt, "90d"),
    );
  });
});

describe("writeAdjudicationOutput", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  it("writes valid JSON preserving every documented field", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "escalation-intelligence-adj-test-"));
    const filePath = adjudicationOutputFilePath(dir, createdAt, "90d");
    const value = output([result("1")]);

    await writeAdjudicationOutput(value, filePath);
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as AdjudicationOutput;

    expect(parsed).toEqual(value);
    expect(parsed.metadata.candidateSimilarityFloor).toBe(0.6);
    expect(parsed.results[0]?.proposedRecurringIssueName).toBeTruthy();
    expect(parsed.results[0]?.a.permalink).toBe("https://slack/a");
  });
});

describe("countRelationships", () => {
  it("counts each relationship type", () => {
    const counts = countRelationships([
      result("1", { relationship: "same_underlying_issue" }),
      result("2", { relationship: "related_problem_family" }),
      result("3", { relationship: "different" }),
      result("4", { relationship: "different" }),
    ]);

    expect(counts).toMatchObject({ same_underlying_issue: 1, related_problem_family: 1, different: 2 });
    // Both vocabularies are always present, zeroed, so absent verdicts are visible.
    expect(counts.same_underlying_workflow).toBe(0);
  });

  it("ignores failed results", () => {
    const counts = countRelationships([
      result("1", { status: "failed", relationship: undefined, error: "boom" }),
    ]);
    expect(counts).toEqual(emptyRelationshipCounts());
  });
});

describe("buildPriorAdjudicationIndex / lookupPriorAdjudication", () => {
  it("indexes successes by pairId + prompt version + model", () => {
    const index = buildPriorAdjudicationIndex([output([result("1")])]);
    expect(lookupPriorAdjudication(index, "1", "v1", "claude-haiku-4-5")).toBeDefined();
  });

  it("does not reuse a result from a different prompt version", () => {
    const index = buildPriorAdjudicationIndex([output([result("1")], "v1")]);
    expect(lookupPriorAdjudication(index, "1", "v2", "claude-haiku-4-5")).toBeUndefined();
  });

  it("does not reuse a result from a different model", () => {
    const index = buildPriorAdjudicationIndex([output([result("1")], "v1", "claude-haiku-4-5")]);
    expect(lookupPriorAdjudication(index, "1", "v1", "claude-sonnet-5")).toBeUndefined();
  });

  it("never indexes failures, so they are retried", () => {
    const index = buildPriorAdjudicationIndex([
      output([result("1", { status: "failed", relationship: undefined, error: "boom" })]),
    ]);
    expect(lookupPriorAdjudication(index, "1", "v1", "claude-haiku-4-5")).toBeUndefined();
  });

  it("returns undefined when there are no prior outputs", () => {
    expect(lookupPriorAdjudication(buildPriorAdjudicationIndex([]), "1", "v1", "m")).toBeUndefined();
  });
});

describe("resumability is scoped by extraction provenance", () => {
  it("indexes verdicts regardless of extraction file (the index itself is provenance-blind)", () => {
    // Documents WHY the CLI filters by extractionsInputFile before indexing:
    // the key carries no extraction identity, so two runs over different
    // extractions collide on the same pairId.
    const fromOldExtraction = output([result("1")]);
    fromOldExtraction.metadata.extractionsInputFile = "data/intelligence/extractions-90d-2026-08-09.json";
    const index = buildPriorAdjudicationIndex([fromOldExtraction]);
    expect(lookupPriorAdjudication(index, "1", "v1", "claude-haiku-4-5")).toBeDefined();
  });

  it("keeps runs from different extraction files distinguishable by metadata", () => {
    const a = output([result("1")]);
    a.metadata.extractionsInputFile = "data/intelligence/extractions-90d-2026-08-09.json";
    const b = output([result("1")]);
    b.metadata.extractionsInputFile = "data/intelligence/extractions-180d-2026-08-12.json";

    const scoped = [a, b].filter(
      (o) => o.metadata.extractionsInputFile === "data/intelligence/extractions-180d-2026-08-12.json",
    );
    expect(scoped).toHaveLength(1);
    expect(buildPriorAdjudicationIndex(scoped).size).toBe(1);
  });
});
