import type { EmbeddingEntry } from "../persistence/embeddingOutput.js";
import { cosineSimilarity } from "./cosineSimilarity.js";

export const DEFAULT_NEIGHBOUR_COUNT = 3;
export const DEFAULT_TOP_PAIR_COUNT = 25;

export interface Neighbour {
  rootTs: string;
  normalizedProblemStatement: string;
  similarity: number;
}

export interface NearestNeighbourReport {
  rootTs: string;
  normalizedProblemStatement: string;
  neighbours: Neighbour[];
}

export interface PairSide {
  rootTs: string;
  normalizedProblemStatement: string;
  permalink: string | null;
}

export interface SimilarPair {
  similarity: number;
  a: PairSide;
  b: PairSide;
}

/**
 * For each escalation, the top N most similar OTHER escalations. Self is
 * always excluded — an item is trivially identical to itself and would
 * otherwise occupy the first slot for everyone.
 *
 * These scores are evidence for choosing a clustering threshold later; this
 * module deliberately makes no judgment about what score means "same issue".
 */
export function computeNearestNeighbours(
  entries: EmbeddingEntry[],
  topN: number = DEFAULT_NEIGHBOUR_COUNT,
): NearestNeighbourReport[] {
  return entries.map((entry, index) => {
    const neighbours = entries
      .map((other, otherIndex) =>
        otherIndex === index
          ? null
          : {
              rootTs: other.rootTs,
              normalizedProblemStatement: other.normalizedProblemStatement,
              similarity: cosineSimilarity(entry.vector, other.vector),
            },
      )
      .filter((neighbour): neighbour is Neighbour => neighbour !== null)
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, topN);

    return {
      rootTs: entry.rootTs,
      normalizedProblemStatement: entry.normalizedProblemStatement,
      neighbours,
    };
  });
}

function toPairSide(entry: EmbeddingEntry): PairSide {
  return {
    rootTs: entry.rootTs,
    normalizedProblemStatement: entry.normalizedProblemStatement,
    permalink: entry.permalink,
  };
}

/**
 * Every unique unordered pair, highest similarity first. Only i<j pairs are
 * considered, so (A,B) and (B,A) are never both reported. Computed once and
 * reused for the top-N list, the distribution buckets, and the summary
 * statistics rather than walking the matrix three times.
 */
export function computeAllPairs(entries: EmbeddingEntry[]): SimilarPair[] {
  const pairs: SimilarPair[] = [];

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const left = entries[i] as EmbeddingEntry;
      const right = entries[j] as EmbeddingEntry;
      pairs.push({
        similarity: cosineSimilarity(left.vector, right.vector),
        a: toPairSide(left),
        b: toPairSide(right),
      });
    }
  }

  return pairs.sort((left, right) => right.similarity - left.similarity);
}

/** The most similar unique pairs across the whole dataset, highest first. */
export function computeTopPairs(
  entries: EmbeddingEntry[],
  topN: number = DEFAULT_TOP_PAIR_COUNT,
): SimilarPair[] {
  return computeAllPairs(entries).slice(0, topN);
}
