import { z } from "zod";
import type { Relationship } from "./recurrenceAdjudication.js";

export const WorkflowRelationshipSchema = z.enum(["same_underlying_workflow", "related_workflow_family", "different"]);

export type WorkflowRelationship = z.infer<typeof WorkflowRelationshipSchema>;

export const WORKFLOW_RELATIONSHIPS: readonly WorkflowRelationship[] = WorkflowRelationshipSchema.options;

/** Either track's vocabulary; both share `different`. */
export type AnyRelationship = Relationship | WorkflowRelationship;

/**
 * The "these belong to the same recurring thing" verdict in either
 * vocabulary. Grouping keys off this rather than a hard-coded string so one
 * graph implementation serves both tracks.
 */
export function isSameRelationship(relationship: string | undefined): boolean {
  return relationship === "same_underlying_issue" || relationship === "same_underlying_workflow";
}

export function isRelatedRelationship(relationship: string | undefined): boolean {
  return relationship === "related_problem_family" || relationship === "related_workflow_family";
}

export const WorkflowAdjudicationLLMOutputSchema = z.object({
  relationship: WorkflowRelationshipSchema,
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  /** Populated only for same_underlying_workflow; enforced in code, see below. */
  proposedWorkflowName: z.string().nullable(),
});

export type WorkflowAdjudicationLLMOutput = z.infer<typeof WorkflowAdjudicationLLMOutputSchema>;

type WorkflowNameInvariantFields = Pick<
  WorkflowAdjudicationLLMOutput,
  "relationship" | "proposedWorkflowName"
>;

export function violatesWorkflowNameInvariant(output: WorkflowNameInvariantFields): boolean {
  return output.relationship !== "same_underlying_workflow" && output.proposedWorkflowName !== null;
}

/**
 * Only a same_underlying_workflow verdict may carry a workflow name; a name on a
 * RELATED or DIFFERENT pair would later be mistaken for a recurring group
 * label. Enforced structurally rather than trusted from the prompt, for the
 * same reason as the technical track: cross-field rules cannot be expressed
 * in JSON Schema.
 */
export function enforceWorkflowNameInvariant<T extends WorkflowAdjudicationLLMOutput>(output: T): T {
  if (violatesWorkflowNameInvariant(output)) {
    return { ...output, proposedWorkflowName: null };
  }
  if (
    output.relationship === "same_underlying_workflow" &&
    output.proposedWorkflowName !== null &&
    output.proposedWorkflowName.trim() === ""
  ) {
    return { ...output, proposedWorkflowName: null };
  }
  return output;
}
