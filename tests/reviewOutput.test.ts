import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  REVIEW_INSTRUCTIONS,
  reviewOutputFilePath,
  writeReviewOutput,
  type ReviewOutput,
} from "../src/persistence/reviewOutput.js";

const createdAt = new Date("2026-08-10T09:30:00.000Z");

function makeOutput(): ReviewOutput {
  return {
    metadata: {
      inputFile: "data/intelligence/embeddings-90d-2026-08-09.json",
      createdAt: createdAt.toISOString(),
      embeddingModel: "voyage-4-large",
      embeddingDimension: 1024,
      sourceWindowDays: 90,
      totalTechnicalEscalations: 70,
      totalUniquePairs: 2415,
      reviewPairCount: 1,
      maxPerBucket: 12,
      topBucketCap: 50,
      buckets: [{ label: ">= 0.80", available: 6, selected: 6 }],
    },
    instructions: REVIEW_INSTRUCTIONS,
    pairs: [
      {
        pairId: "1.0::2.0",
        bucket: ">= 0.80",
        similarity: 0.8839,
        a: { rootTs: "1.0", normalizedProblemStatement: "A statement", permalink: "https://slack/a" },
        b: { rootTs: "2.0", normalizedProblemStatement: "B statement", permalink: "https://slack/b" },
        sameUnderlyingIssue: null,
        reviewerNotes: "",
      },
    ],
  };
}

describe("reviewOutputFilePath", () => {
  it("includes the window tag and creation date", () => {
    expect(reviewOutputFilePath("/d/reviews", createdAt, "90d")).toBe(
      path.join("/d/reviews", "similarity-review-90d-2026-08-10.json"),
    );
  });

  it("omits the tag when the source window is unknown", () => {
    expect(reviewOutputFilePath("/d/reviews", createdAt)).toBe(
      path.join("/d/reviews", "similarity-review-2026-08-10.json"),
    );
  });

  it("does not collide across windows on the same day", () => {
    expect(reviewOutputFilePath("/d", createdAt, "30d")).not.toBe(reviewOutputFilePath("/d", createdAt, "90d"));
  });
});

describe("writeReviewOutput", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  it("creates the reviews directory and writes valid JSON", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "escalation-intelligence-review-test-"));
    const filePath = reviewOutputFilePath(path.join(dir, "data", "intelligence", "reviews"), createdAt, "90d");
    const output = makeOutput();

    await writeReviewOutput(output, filePath);
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as ReviewOutput;

    expect(parsed).toEqual(output);
    expect(Object.keys(parsed).sort()).toEqual(["instructions", "metadata", "pairs"]);
  });

  it("writes blank, reviewer-fillable fields on every pair", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "escalation-intelligence-review-test-"));
    const filePath = reviewOutputFilePath(dir, createdAt, "90d");

    await writeReviewOutput(makeOutput(), filePath);
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as ReviewOutput;

    for (const pair of parsed.pairs) {
      expect(pair.sameUnderlyingIssue).toBeNull();
      expect(pair.reviewerNotes).toBe("");
    }
  });

  it("includes everything a reviewer needs to check a pair against Slack", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "escalation-intelligence-review-test-"));
    const filePath = reviewOutputFilePath(dir, createdAt, "90d");

    await writeReviewOutput(makeOutput(), filePath);
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as ReviewOutput;
    const pair = parsed.pairs[0]!;

    expect(pair.similarity).toBeCloseTo(0.8839, 4);
    for (const side of [pair.a, pair.b]) {
      expect(side.rootTs).toBeTruthy();
      expect(side.normalizedProblemStatement).toBeTruthy();
      expect(side.permalink).toBeTruthy();
    }
  });

  it("writes byte-identical output for identical input (deterministic artifact)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "escalation-intelligence-review-test-"));
    const first = path.join(dir, "first.json");
    const second = path.join(dir, "second.json");

    await writeReviewOutput(makeOutput(), first);
    await writeReviewOutput(makeOutput(), second);

    expect(await readFile(first, "utf8")).toBe(await readFile(second, "utf8"));
  });
});

describe("REVIEW_INSTRUCTIONS", () => {
  it("tells the reviewer the accepted label values", () => {
    const text = REVIEW_INSTRUCTIONS.join(" ");
    expect(text).toContain("true");
    expect(text).toContain("false");
    expect(text).toContain("unsure");
  });

  it("does not suggest a similarity cutoff to the reviewer", () => {
    const text = REVIEW_INSTRUCTIONS.join(" ").toLowerCase();
    expect(text).toContain("do not try to infer a similarity cutoff");
    expect(text).not.toMatch(/pairs above 0\.\d+ are/);
  });
});
