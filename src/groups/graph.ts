export type AdjacencyMap = Map<string, Set<string>>;

/** Undirected adjacency over SAME edges only. */
export function buildAdjacency(edges: Array<[string, string]>): AdjacencyMap {
  const adjacency: AdjacencyMap = new Map();
  const ensure = (node: string): Set<string> => {
    let neighbours = adjacency.get(node);
    if (!neighbours) {
      neighbours = new Set();
      adjacency.set(node, neighbours);
    }
    return neighbours;
  };

  for (const [a, b] of edges) {
    if (a === b) {
      continue;
    }
    ensure(a).add(b);
    ensure(b).add(a);
  }
  return adjacency;
}

/**
 * Connected components, each sorted, and the components themselves ordered
 * deterministically so repeated runs produce identical output.
 */
export function connectedComponents(adjacency: AdjacencyMap): string[][] {
  const visited = new Set<string>();
  const components: string[][] = [];

  for (const start of [...adjacency.keys()].sort()) {
    if (visited.has(start)) {
      continue;
    }

    const stack = [start];
    visited.add(start);
    const component: string[] = [];

    while (stack.length > 0) {
      const node = stack.pop() as string;
      component.push(node);
      for (const neighbour of [...(adjacency.get(node) ?? [])].sort()) {
        if (!visited.has(neighbour)) {
          visited.add(neighbour);
          stack.push(neighbour);
        }
      }
    }

    components.push(component.sort());
  }

  return components.sort((left, right) => (left[0] as string).localeCompare(right[0] as string));
}

/**
 * Bron–Kerbosch with pivoting, restricted to `nodes`. Used only to split a
 * component whose internal evidence contradicts itself; every clique it
 * returns has an explicit SAME adjudication between all its members.
 *
 * Node iteration is sorted throughout, so the set of cliques and their order
 * are deterministic for a given graph.
 */
export function maximalCliques(adjacency: AdjacencyMap, nodes: string[]): string[][] {
  const scope = new Set(nodes);
  const neighboursOf = (node: string): Set<string> =>
    new Set([...(adjacency.get(node) ?? [])].filter((n) => scope.has(n)));

  const cliques: string[][] = [];

  const expand = (potentialClique: string[], candidates: Set<string>, excluded: Set<string>): void => {
    if (candidates.size === 0 && excluded.size === 0) {
      if (potentialClique.length > 0) {
        cliques.push([...potentialClique].sort());
      }
      return;
    }

    // Pivot on the vertex with the most candidate neighbours to prune branches.
    const pivotPool = [...candidates, ...excluded].sort();
    let pivot = pivotPool[0] as string;
    let bestDegree = -1;
    for (const node of pivotPool) {
      const degree = [...neighboursOf(node)].filter((n) => candidates.has(n)).length;
      if (degree > bestDegree) {
        bestDegree = degree;
        pivot = node;
      }
    }

    const pivotNeighbours = neighboursOf(pivot);
    for (const node of [...candidates].sort()) {
      if (pivotNeighbours.has(node)) {
        continue;
      }
      const nodeNeighbours = neighboursOf(node);
      expand(
        [...potentialClique, node],
        new Set([...candidates].filter((n) => nodeNeighbours.has(n))),
        new Set([...excluded].filter((n) => nodeNeighbours.has(n))),
      );
      candidates.delete(node);
      excluded.add(node);
    }
  };

  expand([], new Set([...nodes].sort()), new Set());

  return cliques.sort((left, right) =>
    left.length === right.length ? left.join("::").localeCompare(right.join("::")) : right.length - left.length,
  );
}

/** Members appearing in more than one group, with the groups they span. */
export function findOverlappingMembers(groups: string[][]): Array<{ member: string; groupIndexes: number[] }> {
  const membership = new Map<string, number[]>();
  for (const [index, group] of groups.entries()) {
    for (const member of group) {
      membership.set(member, [...(membership.get(member) ?? []), index]);
    }
  }

  return [...membership.entries()]
    .filter(([, indexes]) => indexes.length > 1)
    .map(([member, groupIndexes]) => ({ member, groupIndexes }))
    .sort((left, right) => left.member.localeCompare(right.member));
}
