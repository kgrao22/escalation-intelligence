import { describe, expect, it, vi } from "vitest";
import { embedCandidates, planEmbeddingRun } from "../../src/embeddings/runEmbedding.js";
import { UnsafeEmbeddingPayloadError, type EmbeddingCandidate } from "../../src/embeddings/selectCandidates.js";
import { VectorShapeError } from "../../src/embeddings/cosineSimilarity.js";
import type { VoyageEmbedFn } from "../../src/embeddings/voyageClient.js";

function makeCandidates(count: number): EmbeddingCandidate[] {
  return Array.from({ length: count }, (_, i) => ({
    rootTs: `${i + 1}`,
    normalizedProblemStatement: `statement ${i + 1}`,
    classification: "technical_defect",
    permalink: `https://example.slack.com/p${i + 1}`,
    isTechnicalEscalation: true,
    category: "technical" as const,
  }));
}

/** Returns a distinct 2-D vector per input so mapping errors are detectable. */
const echoEmbedFn: VoyageEmbedFn = async ({ input }) => ({
  data: input.map((text, index) => ({
    embedding: [Number(text.split(" ")[1]), 0],
    index,
  })),
});

describe("planEmbeddingRun", () => {
  it("reports eligible count, model, and batch count without calling anything", () => {
    const plan = planEmbeddingRun(makeCandidates(18), "voyage-4", 128);
    expect(plan).toEqual({ eligibleCount: 18, model: "voyage-4", batchSize: 128, batchCount: 1 });
  });

  it("counts multiple batches when the dataset exceeds the batch size", () => {
    expect(planEmbeddingRun(makeCandidates(300), "voyage-4", 128).batchCount).toBe(3);
  });
});

describe("embedCandidates", () => {
  it("embeds all candidates in a single batch when they fit", async () => {
    const embedFn = vi.fn(echoEmbedFn);
    const result = await embedCandidates({ candidates: makeCandidates(18), embedFn, model: "voyage-4" });

    expect(embedFn).toHaveBeenCalledTimes(1);
    expect(result.entries).toHaveLength(18);
    expect(result.dimension).toBe(2);
  });

  it("sends only the normalized problem statements to the embed function", async () => {
    const embedFn = vi.fn(echoEmbedFn);
    await embedCandidates({ candidates: makeCandidates(3), embedFn, model: "voyage-4" });

    const request = embedFn.mock.calls[0]?.[0];
    expect(request?.input).toEqual(["statement 1", "statement 2", "statement 3"]);
    expect(request?.model).toBe("voyage-4");
  });

  it("splits into multiple batches and preserves overall ordering", async () => {
    const embedFn = vi.fn(echoEmbedFn);
    const result = await embedCandidates({
      candidates: makeCandidates(5),
      embedFn,
      model: "voyage-4",
      batchSize: 2,
    });

    expect(embedFn).toHaveBeenCalledTimes(3);
    expect(result.entries.map((e) => e.rootTs)).toEqual(["1", "2", "3", "4", "5"]);
    // Each vector's first component encodes its statement number.
    expect(result.entries.map((e) => e.vector[0])).toEqual([1, 2, 3, 4, 5]);
  });

  it("maps each embedding back to the correct rootTs even when the API returns them out of order", async () => {
    const shuffledEmbedFn: VoyageEmbedFn = async ({ input }) => ({
      data: input
        .map((text, index) => ({ embedding: [Number(text.split(" ")[1]), 0], index }))
        .reverse(),
    });

    const result = await embedCandidates({
      candidates: makeCandidates(3),
      embedFn: shuffledEmbedFn,
      model: "voyage-4",
    });

    expect(result.entries.map((e) => [e.rootTs, e.vector[0]])).toEqual([
      ["1", 1],
      ["2", 2],
      ["3", 3],
    ]);
  });

  it("carries statement, classification, and permalink onto each entry", async () => {
    const result = await embedCandidates({ candidates: makeCandidates(1), embedFn: echoEmbedFn, model: "voyage-4" });
    expect(result.entries[0]).toEqual({
      rootTs: "1",
      normalizedProblemStatement: "statement 1",
      classification: "technical_defect",
      permalink: "https://example.slack.com/p1",
      vector: [1, 0],
    });
  });

  it("reports batch progress", async () => {
    const onBatchProgress = vi.fn();
    await embedCandidates({
      candidates: makeCandidates(5),
      embedFn: echoEmbedFn,
      model: "voyage-4",
      batchSize: 2,
      onBatchProgress,
    });

    expect(onBatchProgress).toHaveBeenCalledTimes(3);
    expect(onBatchProgress).toHaveBeenNthCalledWith(1, 1, 3, 2);
    expect(onBatchProgress).toHaveBeenNthCalledWith(3, 3, 3, 1);
  });

  it("refuses to call the embed function at all when a non-technical item is present", async () => {
    const embedFn = vi.fn(echoEmbedFn);
    const candidates = makeCandidates(2);
    (candidates[1] as EmbeddingCandidate).isTechnicalEscalation = false;

    await expect(embedCandidates({ candidates, embedFn, model: "voyage-4" })).rejects.toThrow(
      UnsafeEmbeddingPayloadError,
    );
    expect(embedFn).not.toHaveBeenCalled();
  });

  it("throws when the provider returns inconsistent dimensions", async () => {
    const raggedEmbedFn: VoyageEmbedFn = async ({ input }) => ({
      data: input.map((_, index) => ({ embedding: index === 0 ? [1, 2] : [1, 2, 3], index })),
    });

    await expect(
      embedCandidates({ candidates: makeCandidates(2), embedFn: raggedEmbedFn, model: "voyage-4" }),
    ).rejects.toThrow(VectorShapeError);
  });

  it("throws when there is nothing to embed", async () => {
    const embedFn = vi.fn(echoEmbedFn);
    await expect(embedCandidates({ candidates: [], embedFn, model: "voyage-4" })).rejects.toThrow(
      /No eligible technical escalations/,
    );
    expect(embedFn).not.toHaveBeenCalled();
  });
});
