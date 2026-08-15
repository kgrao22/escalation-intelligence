import { z } from "zod";

export const RelationshipSchema = z.enum(["same_underlying_issue", "related_problem_family", "different"]);

export type Relationship = z.infer<typeof RelationshipSchema>;

export const RELATIONSHIPS: readonly Relationship[] = [
  "same_underlying_issue",
  "related_problem_family",
  "different",
] as const;

/**
 * What the LLM generates. `pairId` and `similarity` are excluded on purpose —
 * both are already known locally, so asking the model to echo identifiers it
 * could corrupt buys nothing.
 *
 * The "issue name only for same_underlying_issue" rule is deliberately NOT a
 * Zod `.refine()`: cross-field refinements cannot be expressed in JSON
 * Schema, so `zodOutputFormat` silently drops them — the constraint would
 * never reach the model, yet would still fail client-side validation and turn
 * an otherwise-usable adjudication into a failure. It is enforced
 * structurally by enforceIssueNameInvariant() instead.
 */
export const RecurrenceAdjudicationLLMOutputSchema = z.object({
  relationship: RelationshipSchema,
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  proposedRecurringIssueName: z.string().nullable(),
});

export type RecurrenceAdjudicationLLMOutput = z.infer<typeof RecurrenceAdjudicationLLMOutputSchema>;

type IssueNameInvariantFields = Pick<
  RecurrenceAdjudicationLLMOutput,
  "relationship" | "proposedRecurringIssueName"
>;

/** True when a non-SAME verdict carries a recurring-issue name it should not have. */
export function violatesIssueNameInvariant(output: IssueNameInvariantFields): boolean {
  return output.relationship !== "same_underlying_issue" && output.proposedRecurringIssueName !== null;
}

/**
 * Guarantees that only SAME_UNDERLYING_ISSUE pairs carry a proposed recurring
 * issue name. A name on a RELATED or DIFFERENT pair would later be mistaken
 * for a recurring cluster label, so this must hold structurally rather than
 * depend on the model complying with the prompt.
 *
 * An empty or whitespace-only name on a SAME verdict is normalised to null so
 * downstream code never has to treat "" as a usable cluster name.
 */
export function enforceIssueNameInvariant<T extends RecurrenceAdjudicationLLMOutput>(output: T): T {
  if (violatesIssueNameInvariant(output)) {
    return { ...output, proposedRecurringIssueName: null };
  }
  if (
    output.relationship === "same_underlying_issue" &&
    output.proposedRecurringIssueName !== null &&
    output.proposedRecurringIssueName.trim() === ""
  ) {
    return { ...output, proposedRecurringIssueName: null };
  }
  return output;
}
