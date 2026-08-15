import { describe, expect, it, vi } from "vitest";
import {
  createVoyageEmbedFn,
  orderBatchEmbeddings,
  VoyageApiError,
  type VoyageEmbeddingResponse,
} from "../../src/embeddings/voyageClient.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("createVoyageEmbedFn", () => {
  it("posts to the Voyage embeddings endpoint with bearer auth and the model + inputs", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ data: [{ embedding: [1, 0], index: 0 }], model: "voyage-4" } satisfies VoyageEmbeddingResponse),
    );
    const embed = createVoyageEmbedFn("pa-test-key", fetchMock as unknown as typeof fetch);

    await embed({ model: "voyage-4", input: ["a statement"] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe("https://api.voyageai.com/v1/embeddings");
    const init = call?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer pa-test-key");
    expect(JSON.parse(init.body as string)).toEqual({ model: "voyage-4", input: ["a statement"] });
  });

  it("does not send input_type, so symmetric comparison is not skewed by a retrieval prompt", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ data: [{ embedding: [1], index: 0 }] }),
    );
    const embed = createVoyageEmbedFn("pa-test-key", fetchMock as unknown as typeof fetch);

    await embed({ model: "voyage-4", input: ["x"] });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).not.toHaveProperty("input_type");
  });

  it("throws VoyageApiError on a non-2xx response", async () => {
    const fetchMock = vi.fn(async () => new Response("rate limited", { status: 429 }));
    const embed = createVoyageEmbedFn("pa-test-key", fetchMock as unknown as typeof fetch);

    await expect(embed({ model: "voyage-4", input: ["x"] })).rejects.toThrow(VoyageApiError);
  });

  it("never includes the API key in an error message", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    const embed = createVoyageEmbedFn("pa-super-secret-key", fetchMock as unknown as typeof fetch);

    await expect(embed({ model: "voyage-4", input: ["x"] })).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("pa-super-secret-key") }) as Error,
    );
  });
});

describe("orderBatchEmbeddings", () => {
  it("returns embeddings in input order", () => {
    const response: VoyageEmbeddingResponse = {
      data: [
        { embedding: [1, 1], index: 0 },
        { embedding: [2, 2], index: 1 },
        { embedding: [3, 3], index: 2 },
      ],
    };
    expect(orderBatchEmbeddings(response, 3)).toEqual([[1, 1], [2, 2], [3, 3]]);
  });

  it("reorders out-of-order responses by index rather than trusting array order", () => {
    const response: VoyageEmbeddingResponse = {
      data: [
        { embedding: [3, 3], index: 2 },
        { embedding: [1, 1], index: 0 },
        { embedding: [2, 2], index: 1 },
      ],
    };
    expect(orderBatchEmbeddings(response, 3)).toEqual([[1, 1], [2, 2], [3, 3]]);
  });

  it("throws when the count does not match the batch size", () => {
    const response: VoyageEmbeddingResponse = { data: [{ embedding: [1], index: 0 }] };
    expect(() => orderBatchEmbeddings(response, 2)).toThrow(/expected 2 embeddings but received 1/);
  });

  it("throws when indices are not a contiguous 0..n-1 range", () => {
    const response: VoyageEmbeddingResponse = {
      data: [
        { embedding: [1], index: 0 },
        { embedding: [2], index: 5 },
      ],
    };
    expect(() => orderBatchEmbeddings(response, 2)).toThrow(/contiguous/);
  });

  it("throws on duplicate indices, which would silently mis-map an embedding", () => {
    const response: VoyageEmbeddingResponse = {
      data: [
        { embedding: [1], index: 0 },
        { embedding: [2], index: 0 },
      ],
    };
    expect(() => orderBatchEmbeddings(response, 2)).toThrow(/contiguous/);
  });
});
