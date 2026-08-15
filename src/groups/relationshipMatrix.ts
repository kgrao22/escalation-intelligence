import {
  isRelatedRelationship,
  isSameRelationship,
  type AnyRelationship,
} from "../llm/schemas/workflowAdjudication.js";
import type { AdjudicationResultItem } from "../persistence/adjudicationOutput.js";

/**
 * `no_adjudication` is a first-class outcome, not an error: pairs below the
 * candidate similarity floor were never sent to the LLM, so the absence of a
 * verdict is expected. Treating it as distinct from `different` is what lets
 * group construction tell missing evidence apart from contradictory evidence.
 */
export type PairRelationship = AnyRelationship | "no_adjudication";

export interface RelationshipMatrix {
  relationship(a: string, b: string): PairRelationship;
  pairId(a: string, b: string): string;
  /** Every successful SAME adjudication, for edge aggregation. */
  sameEdges: AdjudicationResultItem[];
}

/** Order-independent key so relationship(a,b) === relationship(b,a). */
export function memberPairKey(a: string, b: string): string {
  return [a, b].sort().join("::");
}

export function buildRelationshipMatrix(results: AdjudicationResultItem[]): RelationshipMatrix {
  const byPair = new Map<string, AnyRelationship>();
  const sameEdges: AdjudicationResultItem[] = [];

  for (const result of results) {
    if (result.status !== "success" || !result.relationship) {
      continue;
    }
    byPair.set(memberPairKey(result.a.rootTs, result.b.rootTs), result.relationship);
    if (isSameRelationship(result.relationship)) {
      sameEdges.push(result);
    }
  }

  return {
    relationship(a, b) {
      if (a === b) {
        // A thread is trivially itself; never treated as evidence.
        return "same_underlying_issue";
      }
      return byPair.get(memberPairKey(a, b)) ?? "no_adjudication";
    },
    pairId: memberPairKey,
    sameEdges,
  };
}

/** All unordered member pairs of a group, in deterministic order. */
export function allMemberPairs(members: string[]): Array<[string, string]> {
  const sorted = [...members].sort();
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      pairs.push([sorted[i] as string, sorted[j] as string]);
    }
  }
  return pairs;
}

export interface ConsistencyReport {
  consistency: "fully_confirmed" | "incomplete_pair_evidence" | "conflicted";
  sameEdges: string[];
  relatedEdgesInsideGroup: string[];
  differentEdgesInsideGroup: string[];
  unadjudicatedPairs: string[];
}

/**
 * Classifies a proposed group by what the adjudicator actually said about
 * every pair inside it.
 *
 * - conflicted: at least one internal pair is explicitly RELATED or DIFFERENT.
 *   Transitivity must not be assumed over contradicting evidence.
 * - incomplete_pair_evidence: nothing contradicts the group, but some pair was
 *   never adjudicated. Flagged for review rather than assumed equivalent.
 * - fully_confirmed: every internal pair was explicitly adjudicated SAME.
 */
export function assessGroupConsistency(members: string[], matrix: RelationshipMatrix): ConsistencyReport {
  const sameEdges: string[] = [];
  const relatedEdgesInsideGroup: string[] = [];
  const differentEdgesInsideGroup: string[] = [];
  const unadjudicatedPairs: string[] = [];

  for (const [a, b] of allMemberPairs(members)) {
    const pairId = matrix.pairId(a, b);
    const relationship = matrix.relationship(a, b);
    if (isSameRelationship(relationship)) {
      sameEdges.push(pairId);
    } else if (isRelatedRelationship(relationship)) {
      relatedEdgesInsideGroup.push(pairId);
    } else if (relationship === "different") {
      differentEdgesInsideGroup.push(pairId);
    } else {
      unadjudicatedPairs.push(pairId);
    }
  }

  const consistency =
    relatedEdgesInsideGroup.length > 0 || differentEdgesInsideGroup.length > 0
      ? "conflicted"
      : unadjudicatedPairs.length > 0
        ? "incomplete_pair_evidence"
        : "fully_confirmed";

  return { consistency, sameEdges, relatedEdgesInsideGroup, differentEdgesInsideGroup, unadjudicatedPairs };
}
