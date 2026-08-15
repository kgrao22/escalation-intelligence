const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";

export interface VoyageEmbeddingRequest {
  model: string;
  input: string[];
}

export interface VoyageEmbeddingDatum {
  embedding: number[];
  index: number;
}

export interface VoyageEmbeddingResponse {
  data: VoyageEmbeddingDatum[];
  model?: string;
  usage?: { total_tokens?: number };
}

/**
 * Decoupled from HTTP on purpose, exactly as the Anthropic parse function
 * is: business logic only needs "given texts, get vectors back", which makes
 * it trivial to fake in tests and impossible to reach the network from one.
 */
export type VoyageEmbedFn = (request: VoyageEmbeddingRequest) => Promise<VoyageEmbeddingResponse>;

export class VoyageApiError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`Voyage API request failed (HTTP ${status}): ${detail}`);
    this.name = "VoyageApiError";
    this.status = status;
  }
}

export function createVoyageEmbedFn(apiKey: string, fetchImpl: typeof fetch = fetch): VoyageEmbedFn {
  return async ({ model, input }) => {
    // `input_type` is deliberately omitted. Setting "query" or "document"
    // prepends a retrieval-specific prompt intended for asymmetric
    // query→document matching; here we compare problem statements against
    // each other symmetrically, so the neutral default is correct.
    const response = await fetchImpl(VOYAGE_EMBEDDINGS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input }),
    });

    if (!response.ok) {
      // Body text only — the request headers (which carry the key) are never
      // included in the error.
      let detail: string;
      try {
        detail = (await response.text()).slice(0, 500);
      } catch {
        detail = response.statusText;
      }
      throw new VoyageApiError(response.status, detail);
    }

    return (await response.json()) as VoyageEmbeddingResponse;
  };
}

/**
 * Maps a batch response back to input order. Voyage returns an `index` per
 * embedding; this sorts by it and verifies the set is exactly 0..n-1 rather
 * than trusting array order, so an embedding can never be attached to the
 * wrong escalation.
 */
export function orderBatchEmbeddings(response: VoyageEmbeddingResponse, expectedCount: number): number[][] {
  if (response.data.length !== expectedCount) {
    throw new VoyageApiError(
      200,
      `expected ${expectedCount} embeddings but received ${response.data.length}.`,
    );
  }

  const sorted = [...response.data].sort((a, b) => a.index - b.index);
  for (const [position, datum] of sorted.entries()) {
    if (datum.index !== position) {
      throw new VoyageApiError(
        200,
        `embedding indices are not a contiguous 0..${expectedCount - 1} range (saw ${datum.index} at position ${position}).`,
      );
    }
  }

  return sorted.map((datum) => datum.embedding);
}
