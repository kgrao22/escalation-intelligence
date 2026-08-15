import { describe, expect, it } from "vitest";
import {
  buildAdjacency,
  connectedComponents,
  findOverlappingMembers,
  maximalCliques,
} from "../../src/groups/graph.js";

describe("buildAdjacency", () => {
  it("builds an undirected graph", () => {
    const adjacency = buildAdjacency([["A", "B"]]);
    expect([...(adjacency.get("A") ?? [])]).toEqual(["B"]);
    expect([...(adjacency.get("B") ?? [])]).toEqual(["A"]);
  });

  it("ignores self-edges", () => {
    expect(buildAdjacency([["A", "A"]]).size).toBe(0);
  });
});

describe("connectedComponents", () => {
  it("finds a single 2-member component", () => {
    expect(connectedComponents(buildAdjacency([["A", "B"]]))).toEqual([["A", "B"]]);
  });

  it("finds a 3-member component from a chain", () => {
    expect(
      connectedComponents(
        buildAdjacency([
          ["A", "B"],
          ["B", "C"],
        ]),
      ),
    ).toEqual([["A", "B", "C"]]);
  });

  it("separates disconnected components", () => {
    const components = connectedComponents(
      buildAdjacency([
        ["A", "B"],
        ["C", "D"],
      ]),
    );
    expect(components).toEqual([
      ["A", "B"],
      ["C", "D"],
    ]);
  });

  it("is deterministic regardless of edge insertion order", () => {
    const forward = connectedComponents(
      buildAdjacency([
        ["A", "B"],
        ["B", "C"],
        ["X", "Y"],
      ]),
    );
    const reversed = connectedComponents(
      buildAdjacency([
        ["Y", "X"],
        ["C", "B"],
        ["B", "A"],
      ]),
    );
    expect(forward).toEqual(reversed);
  });
});

describe("maximalCliques", () => {
  it("returns the whole triangle when fully connected", () => {
    const adjacency = buildAdjacency([
      ["A", "B"],
      ["B", "C"],
      ["A", "C"],
    ]);
    expect(maximalCliques(adjacency, ["A", "B", "C"])).toEqual([["A", "B", "C"]]);
  });

  it("splits a chain into its two maximal edges", () => {
    const adjacency = buildAdjacency([
      ["A", "B"],
      ["B", "C"],
    ]);
    expect(maximalCliques(adjacency, ["A", "B", "C"])).toEqual([
      ["A", "B"],
      ["B", "C"],
    ]);
  });

  it("emits no clique that is a subset of another", () => {
    const adjacency = buildAdjacency([
      ["A", "B"],
      ["B", "C"],
      ["A", "C"],
      ["C", "D"],
    ]);
    const cliques = maximalCliques(adjacency, ["A", "B", "C", "D"]);
    for (const clique of cliques) {
      const others = cliques.filter((c) => c !== clique);
      const isSubset = others.some((other) => clique.every((node) => other.includes(node)));
      expect(isSubset).toBe(false);
    }
  });

  it("is deterministic across repeated runs", () => {
    const adjacency = buildAdjacency([
      ["A", "B"],
      ["B", "C"],
      ["C", "D"],
      ["A", "D"],
    ]);
    expect(maximalCliques(adjacency, ["A", "B", "C", "D"])).toEqual(
      maximalCliques(adjacency, ["D", "C", "B", "A"]),
    );
  });

  it("orders larger cliques first", () => {
    const adjacency = buildAdjacency([
      ["A", "B"],
      ["B", "C"],
      ["A", "C"],
      ["C", "D"],
    ]);
    const cliques = maximalCliques(adjacency, ["A", "B", "C", "D"]);
    expect(cliques[0]).toEqual(["A", "B", "C"]);
  });
});

describe("findOverlappingMembers", () => {
  it("detects a member shared between two groups", () => {
    expect(
      findOverlappingMembers([
        ["A", "B"],
        ["B", "C"],
      ]),
    ).toEqual([{ member: "B", groupIndexes: [0, 1] }]);
  });

  it("returns nothing when groups are disjoint", () => {
    expect(
      findOverlappingMembers([
        ["A", "B"],
        ["C", "D"],
      ]),
    ).toEqual([]);
  });
});
