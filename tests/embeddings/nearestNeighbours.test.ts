import { describe, expect, it } from "vitest";
import {
  computeAllPairs,
  computeNearestNeighbours,
  computeTopPairs,
  DEFAULT_TOP_PAIR_COUNT,
} from "../../src/embeddings/nearestNeighbours.js";
import { expectedUniquePairCount } from "../../src/embeddings/similarityStats.js";
import type { EmbeddingEntry } from "../../src/persistence/embeddingOutput.js";

function entry(rootTs: string, statement: string, vector: number[]): EmbeddingEntry {
  return {
    rootTs,
    normalizedProblemStatement: statement,
    classification: "technical_defect",
    permalink: `https://example.slack.com/archives/C1/p${rootTs}`,
    vector,
  };
}

// A and B point in nearly the same direction; C is orthogonal to both.
const entries: EmbeddingEntry[] = [
  entry("A", "Tax omitted from invoice fee types", [1, 0]),
  entry("B", "Tax calculation excludes partner fees", [0.99, 0.14]),
  entry("C", "Bulk vehicle upload times out", [0, 1]),
];

describe("computeNearestNeighbours", () => {
  it("returns one report per entry", () => {
    expect(computeNearestNeighbours(entries)).toHaveLength(3);
  });

  it("never includes the entry itself as its own neighbour", () => {
    for (const report of computeNearestNeighbours(entries)) {
      expect(report.neighbours.map((n) => n.rootTs)).not.toContain(report.rootTs);
    }
  });

  it("ranks the semantically closest entry first", () => {
    const reportForA = computeNearestNeighbours(entries).find((r) => r.rootTs === "A");
    expect(reportForA?.neighbours[0]?.rootTs).toBe("B");
    expect(reportForA?.neighbours[0]?.similarity).toBeGreaterThan(0.9);
  });

  it("sorts neighbours by descending similarity", () => {
    for (const report of computeNearestNeighbours(entries)) {
      const scores = report.neighbours.map((n) => n.similarity);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
    }
  });

  it("respects the requested neighbour count", () => {
    for (const report of computeNearestNeighbours(entries, 1)) {
      expect(report.neighbours).toHaveLength(1);
    }
  });

  it("caps neighbours at the number of other entries available", () => {
    const reports = computeNearestNeighbours(entries, 10);
    expect(reports[0]?.neighbours).toHaveLength(2);
  });

  it("returns no neighbours for a single-entry dataset", () => {
    const reports = computeNearestNeighbours([entries[0] as EmbeddingEntry]);
    expect(reports[0]?.neighbours).toEqual([]);
  });
});

describe("computeTopPairs", () => {
  it("returns each unordered pair exactly once", () => {
    const pairs = computeTopPairs(entries);
    // 3 entries → 3 unique pairs (AB, AC, BC), not 6.
    expect(pairs).toHaveLength(3);

    const keys = pairs.map((p) => [p.a.rootTs, p.b.rootTs].sort().join("-")).sort();
    expect(keys).toEqual(["A-B", "A-C", "B-C"]);
  });

  it("never pairs an entry with itself", () => {
    for (const pair of computeTopPairs(entries)) {
      expect(pair.a.rootTs).not.toBe(pair.b.rootTs);
    }
  });

  it("sorts by descending similarity with the closest pair first", () => {
    const pairs = computeTopPairs(entries);
    expect([pairs[0]?.a.rootTs, pairs[0]?.b.rootTs].sort()).toEqual(["A", "B"]);
    expect(pairs.map((p) => p.similarity)).toEqual([...pairs.map((p) => p.similarity)].sort((a, b) => b - a));
  });

  it("respects the requested pair count", () => {
    expect(computeTopPairs(entries, 2)).toHaveLength(2);
  });

  it("returns no pairs for fewer than two entries", () => {
    expect(computeTopPairs([entries[0] as EmbeddingEntry])).toEqual([]);
    expect(computeTopPairs([])).toEqual([]);
  });

  it("carries the statements needed for a human-readable report", () => {
    const top = computeTopPairs(entries, 1)[0];
    expect(top?.a.normalizedProblemStatement).toBeTruthy();
    expect(top?.b.normalizedProblemStatement).toBeTruthy();
  });

  it("carries rootTs and permalink for both sides so pairs can be checked against Slack", () => {
    const top = computeTopPairs(entries, 1)[0];
    expect(top?.a.rootTs).toBeTruthy();
    expect(top?.b.rootTs).toBeTruthy();
    expect(top?.a.permalink).toMatch(/^https:\/\/example\.slack\.com\//);
    expect(top?.b.permalink).toMatch(/^https:\/\/example\.slack\.com\//);
  });

  it("defaults to the top 25 pairs for the larger 90-day dataset", () => {
    expect(DEFAULT_TOP_PAIR_COUNT).toBe(25);
  });

  it("returns at most topN even when far more pairs exist", () => {
    const many = Array.from({ length: 40 }, (_, i) => entry(`${i}`, `statement ${i}`, [Math.cos(i), Math.sin(i)]));
    expect(computeTopPairs(many)).toHaveLength(DEFAULT_TOP_PAIR_COUNT);
    expect(computeAllPairs(many)).toHaveLength(expectedUniquePairCount(40));
  });
});

describe("computeAllPairs", () => {
  it("returns every unique pair, matching n*(n-1)/2", () => {
    expect(computeAllPairs(entries)).toHaveLength(expectedUniquePairCount(entries.length));
  });

  it("is sorted by descending similarity", () => {
    const scores = computeAllPairs(entries).map((p) => p.similarity);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("agrees with computeTopPairs on the leading entries", () => {
    expect(computeAllPairs(entries).slice(0, 2)).toEqual(computeTopPairs(entries, 2));
  });
});
