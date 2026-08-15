import { describe, expect, it } from "vitest";
import {
  assertDisjointIntegrity,
  buildDisjointCliqueCover,
  DisjointGroupIntegrityError,
  type SamePair,
} from "../src/groups/disjointCliqueCover.js";

const p = (a: string, b: string, confidence = 0.9): SamePair => ({ a, b, confidence });

describe("exclusive membership", () => {
  it("never places a node in two groups", () => {
    // Two triangles sharing node B — v1 would emit both cliques containing B.
    const { groups } = buildDisjointCliqueCover([
      p("A", "B"), p("B", "C"), p("A", "C"),
      p("B", "D"), p("D", "E"), p("B", "E"),
    ]);
    const members = groups.flatMap((g) => g.members);
    expect(new Set(members).size).toBe(members.length);
    expect(groups.filter((g) => g.members.includes("B"))).toHaveLength(1);
  });

  it("resolves overlapping cliques by size, then confidence, then id", () => {
    const { groups } = buildDisjointCliqueCover([
      p("A", "B"), p("B", "C"), p("A", "C"), p("A", "D"), p("B", "D"), p("C", "D"),
      p("C", "E"), p("E", "F"), p("C", "F"),
    ]);
    // The 4-clique wins outright; E/F cannot claim C.
    expect(groups[0]?.members).toEqual(["A", "B", "C", "D"]);
    expect(groups.flatMap((g) => g.members)).not.toContain("E");
  });
});

describe("complete-link evidence", () => {
  it("keeps a dense clique intact", () => {
    const { groups } = buildDisjointCliqueCover([
      p("A", "B"), p("B", "C"), p("A", "C"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members).toEqual(["A", "B", "C"]);
    expect(groups[0]?.internalSameEdgeCount).toBe(3);
  });

  it("does NOT merge a transitive chain A-B-C when A and C were never judged SAME", () => {
    const { groups } = buildDisjointCliqueCover([p("A", "B"), p("B", "C")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members).toHaveLength(2);
    // All three never end up together.
    expect(groups[0]?.members).not.toEqual(["A", "B", "C"]);
  });

  it("does not let a single bridge edge merge two dense subgroups", () => {
    const { groups } = buildDisjointCliqueCover([
      p("A", "B"), p("B", "C"), p("A", "C"),
      p("X", "Y"), p("Y", "Z"), p("X", "Z"),
      p("C", "X"), // lone bridge
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.members.length).sort()).toEqual([3, 3]);
  });
});

describe("DIFFERENT verdicts", () => {
  it("cannot coexist inside a group, because a DIFFERENT pair has no SAME edge", () => {
    const same = [p("A", "B"), p("B", "C"), p("A", "C")];
    const { groups } = buildDisjointCliqueCover(same);
    expect(() => assertDisjointIntegrity(groups, same, [{ a: "A", b: "C" }])).toThrow(
      DisjointGroupIntegrityError,
    );
  });

  it("passes integrity when no DIFFERENT pair is inside", () => {
    const same = [p("A", "B"), p("B", "C"), p("A", "C")];
    const { groups } = buildDisjointCliqueCover(same);
    expect(() => assertDisjointIntegrity(groups, same, [{ a: "A", b: "Z" }])).not.toThrow();
  });

  it("rejects a group whose pair lacks direct SAME evidence", () => {
    const fabricated = [{ members: ["A", "B", "C"], internalSameEdgeCount: 3, averageConfidence: 0.9 }];
    expect(() => assertDisjointIntegrity(fabricated, [p("A", "B")], [])).toThrow(/lacks direct SAME evidence/);
  });
});

describe("determinism and singletons", () => {
  it("produces identical output regardless of input order", () => {
    const pairs = [p("A", "B"), p("B", "C"), p("A", "C"), p("D", "E")];
    const forward = buildDisjointCliqueCover(pairs);
    const reversed = buildDisjointCliqueCover([...pairs].reverse());
    expect(reversed.groups).toEqual(forward.groups);
  });

  it("excludes single nodes from groups and reports them as unassigned", () => {
    const { groups, unassigned } = buildDisjointCliqueCover([
      p("A", "B"), p("B", "C"), p("A", "C"), p("C", "D"),
    ]);
    expect(groups[0]?.members).toEqual(["A", "B", "C"]);
    expect(unassigned).toContain("D");
  });

  it("returns nothing for an empty graph", () => {
    const { groups, unassigned } = buildDisjointCliqueCover([]);
    expect(groups).toEqual([]);
    expect(unassigned).toEqual([]);
  });

  it("ignores self-pairs", () => {
    expect(buildDisjointCliqueCover([p("A", "A")]).groups).toEqual([]);
  });
});
