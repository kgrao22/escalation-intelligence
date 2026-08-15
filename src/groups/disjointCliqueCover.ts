/**
 * Complete-link (clique) grouping with exclusive membership.
 *
 * The v1 rule took connected components over SAME edges and, only when a
 * component contained an internal DIFFERENT edge, emitted every maximal clique.
 * At 365-day scale that produced two failures at once:
 *
 *  - A single DIFFERENT edge inside a 32-node component triggered full maximal
 *    clique enumeration, yielding 27 heavily OVERLAPPING groups (one thread
 *    landed in 8 of them) and repeating the same issue name five times.
 *  - Components without a DIFFERENT edge stayed whole even at 13% SAME-edge
 *    density, so a group could be a long transitive chain (A≈B, B≈C) rather
 *    than one issue.
 *
 * This rule fixes both with one property: **every pair inside a group was
 * independently judged SAME**. That makes a group trivially explainable, makes
 * transitive chaining impossible, and makes a DIFFERENT pair inside a group
 * impossible by construction (a DIFFERENT pair has no SAME edge, so it can
 * never appear in a clique).
 *
 * Missing adjudications are NOT treated as DIFFERENT — only pairs actually
 * judged SAME create edges, and candidate generation only ever adjudicated
 * pairs above the similarity floor.
 */

export interface SamePair {
  a: string;
  b: string;
  confidence: number;
}

export interface DisjointGroup {
  members: string[];
  /** Every internal pair is a SAME edge, so this is n*(n-1)/2. */
  internalSameEdgeCount: number;
  averageConfidence: number;
}

export interface DisjointCoverResult {
  groups: DisjointGroup[];
  /** Nodes with SAME edges that no accepted clique claimed. */
  unassigned: string[];
  maximalCliquesConsidered: number;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

/** Bron–Kerbosch with pivoting; deterministic through sorted iteration. */
function enumerateMaximalCliques(adjacency: Map<string, Set<string>>): string[][] {
  const cliques: string[][] = [];

  const expand = (r: Set<string>, p: Set<string>, x: Set<string>): void => {
    if (p.size === 0 && x.size === 0) {
      cliques.push([...r].sort());
      return;
    }
    // Pivot on the highest-degree vertex to cut the search space.
    let pivot: string | undefined;
    let best = -1;
    for (const candidate of [...p, ...x].sort()) {
      const degree = adjacency.get(candidate)?.size ?? 0;
      if (degree > best) {
        best = degree;
        pivot = candidate;
      }
    }
    const pivotNeighbours = pivot ? (adjacency.get(pivot) ?? new Set<string>()) : new Set<string>();
    const candidates = [...p].filter((v) => !pivotNeighbours.has(v)).sort();

    for (const v of candidates) {
      const neighbours = adjacency.get(v) ?? new Set<string>();
      expand(
        new Set([...r, v]),
        new Set([...p].filter((u) => neighbours.has(u))),
        new Set([...x].filter((u) => neighbours.has(u))),
      );
      p.delete(v);
      x.add(v);
    }
  };

  expand(new Set(), new Set(adjacency.keys()), new Set());
  return cliques;
}

/**
 * Greedily claims maximal cliques, largest first, skipping any clique whose
 * members are already spoken for. Ranking is size, then mean SAME-edge
 * confidence, then the lexicographically smallest member — fully deterministic,
 * so the same verdicts always produce the same groups.
 */
export function buildDisjointCliqueCover(pairs: SamePair[], minimumGroupSize = 2): DisjointCoverResult {
  const adjacency = new Map<string, Set<string>>();
  const confidenceByPair = new Map<string, number>();

  for (const pair of pairs) {
    if (pair.a === pair.b) {
      continue;
    }
    confidenceByPair.set(pairKey(pair.a, pair.b), pair.confidence);
    for (const [from, to] of [
      [pair.a, pair.b],
      [pair.b, pair.a],
    ] as const) {
      const existing = adjacency.get(from);
      if (existing) {
        existing.add(to);
      } else {
        adjacency.set(from, new Set([to]));
      }
    }
  }

  const cliques = enumerateMaximalCliques(adjacency);

  const meanConfidence = (members: string[]): number => {
    const values: number[] = [];
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        values.push(confidenceByPair.get(pairKey(members[i] as string, members[j] as string)) ?? 0);
      }
    }
    return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
  };

  const ranked = cliques
    .filter((clique) => clique.length >= minimumGroupSize)
    .map((clique) => ({ clique, confidence: meanConfidence(clique) }))
    .sort(
      (left, right) =>
        right.clique.length - left.clique.length ||
        right.confidence - left.confidence ||
        (left.clique[0] as string).localeCompare(right.clique[0] as string),
    );

  const claimed = new Set<string>();
  const groups: DisjointGroup[] = [];
  for (const { clique, confidence } of ranked) {
    if (clique.some((member) => claimed.has(member))) {
      continue;
    }
    for (const member of clique) {
      claimed.add(member);
    }
    groups.push({
      members: clique,
      internalSameEdgeCount: (clique.length * (clique.length - 1)) / 2,
      averageConfidence: confidence,
    });
  }

  return {
    groups,
    unassigned: [...adjacency.keys()].filter((node) => !claimed.has(node)).sort(),
    maximalCliquesConsidered: cliques.length,
  };
}

export class DisjointGroupIntegrityError extends Error {
  constructor(message: string) {
    super(`Disjoint grouping integrity violated: ${message}`);
    this.name = "DisjointGroupIntegrityError";
  }
}

/**
 * Fails loudly rather than emitting a subtly wrong artifact. Checks exclusive
 * membership, complete-link internal evidence, and absence of DIFFERENT pairs.
 */
export function assertDisjointIntegrity(
  groups: DisjointGroup[],
  samePairs: SamePair[],
  differentPairs: Array<{ a: string; b: string }>,
): void {
  const seen = new Map<string, number>();
  for (const group of groups) {
    for (const member of group.members) {
      seen.set(member, (seen.get(member) ?? 0) + 1);
    }
  }
  const overlapping = [...seen.entries()].filter(([, count]) => count > 1);
  if (overlapping.length > 0) {
    throw new DisjointGroupIntegrityError(
      `${overlapping.length} member(s) appear in more than one group, e.g. ${overlapping[0]?.[0] as string}`,
    );
  }

  const sameSet = new Set(samePairs.map((pair) => pairKey(pair.a, pair.b)));
  const differentSet = new Set(differentPairs.map((pair) => pairKey(pair.a, pair.b)));

  for (const group of groups) {
    for (let i = 0; i < group.members.length; i += 1) {
      for (let j = i + 1; j < group.members.length; j += 1) {
        const key = pairKey(group.members[i] as string, group.members[j] as string);
        if (differentSet.has(key)) {
          throw new DisjointGroupIntegrityError(`group contains a DIFFERENT pair: ${key}`);
        }
        if (!sameSet.has(key)) {
          throw new DisjointGroupIntegrityError(`group pair lacks direct SAME evidence: ${key}`);
        }
      }
    }
  }
}
