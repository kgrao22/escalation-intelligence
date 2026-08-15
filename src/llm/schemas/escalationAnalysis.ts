import { z } from "zod";

export const ClassificationSchema = z.enum([
  "technical_defect",
  "production_incident",
  "integration_issue",
  "data_issue",
  "configuration_issue",
  "feature_limitation",
  "operational_request",
  "access_request",
  "customer_data_update",
  "question_or_support",
  "non_issue",
  "unclear",
]);

export const SeveritySchema = z.enum(["low", "medium", "high", "critical"]);

export const CustomerImpactSchema = z.enum(["none", "single_customer", "multiple_customers", "unknown"]);

export const ResolutionStatusSchema = z.enum(["resolved", "workaround", "unresolved", "not_applicable", "unclear"]);

export const AutomationCandidateSchema = z.enum([
  "permanent_code_fix",
  "automated_diagnostic",
  "self_service_tooling",
  "monitoring_or_alert",
  "process_automation",
  "documentation_or_training",
  "human_review_required",
  "not_applicable",
  "unclear",
]);

/**
 * What the LLM actually generates. Deliberately excludes rootTs/permalink —
 * those are already known from the source thread, so we attach them
 * ourselves after parsing rather than asking the model to echo identifiers
 * it could get wrong.
 *
 * Note: the "normalizedProblemStatement must be null when
 * isTechnicalEscalation is false" rule is deliberately NOT a Zod
 * `.refine()` here. Cross-field refinements cannot be expressed in JSON
 * Schema, so `zodOutputFormat` silently drops them — the constraint would
 * never reach the model, yet would still fail client-side validation and
 * turn an otherwise-good classification into a failed extraction. It is
 * enforced structurally by enforceNonTechnicalInvariant() instead.
 */
/**
 * What kind of repeatable manual action a workflow candidate describes.
 * Free of customer specifics — this is the shape of the task, not the case.
 */
export const WorkflowClassificationSchema = z.enum([
  "policy_state_change",
  "policy_cancellation",
  "policy_reactivation",
  "customer_identity_update",
  "account_data_update",
  "manual_backend_correction",
  "access_or_permission_change",
  "manual_reconciliation",
  "manual_document_operation",
  "other_operational_workflow",
]);

/**
 * How much tooling already exists for the workflow. `unknown` is the honest
 * default — a tool being mentioned in a thread is not proof the workflow is
 * automated.
 */
export const AutomationStatusSchema = z.enum([
  "already_automated",
  "partially_automated",
  "manual",
  "unknown",
]);

export type WorkflowClassification = z.infer<typeof WorkflowClassificationSchema>;
export type AutomationStatus = z.infer<typeof AutomationStatusSchema>;

export const WORKFLOW_CLASSIFICATIONS: readonly WorkflowClassification[] =
  WorkflowClassificationSchema.options;
export const AUTOMATION_STATUSES: readonly AutomationStatus[] = AutomationStatusSchema.options;

export const EscalationAnalysisLLMOutputSchema = z.object({
  isTechnicalEscalation: z.boolean(),
  classification: ClassificationSchema,
  normalizedProblemStatement: z.string().nullable(),
  affectedSystem: z.string().nullable(),
  issueTypeHint: z.string().nullable(),
  severity: SeveritySchema.nullable(),
  customerImpact: CustomerImpactSchema,
  suspectedRootCause: z.string().nullable(),
  rootCauseConfidence: z.number().min(0).max(1).nullable(),
  resolutionStatus: ResolutionStatusSchema,
  resolutionSummary: z.string().nullable(),
  isRecurringEvidenceInThread: z.boolean(),
  automationCandidate: AutomationCandidateSchema,
  automationReasoning: z.string().nullable(),
  confidence: z.number().min(0).max(1),

  // --- Manual operational workflow track (added in prompt v3) ---
  // Deliberately independent of isTechnicalEscalation: a thread can be a
  // defect, a repeatable manual task, both, or neither.
  isAutomationWorkflowCandidate: z.boolean(),
  workflowClassification: WorkflowClassificationSchema.nullable(),
  normalizedWorkflowStatement: z.string().nullable(),
  automationStatus: AutomationStatusSchema,
});

export type EscalationAnalysisLLMOutput = z.infer<typeof EscalationAnalysisLLMOutputSchema>;

/**
 * Full stored record: the LLM's structured judgment plus the two identifying
 * fields we attach ourselves from the source thread.
 */
export interface EscalationAnalysis extends EscalationAnalysisLLMOutput {
  rootTs: string;
  permalink: string | null;
}

type NonTechnicalInvariantFields = Pick<
  EscalationAnalysisLLMOutput,
  "isTechnicalEscalation" | "normalizedProblemStatement"
>;

/** True when a record breaks the invariant — a non-technical item carrying a problem statement. */
export function violatesNonTechnicalInvariant(output: NonTechnicalInvariantFields): boolean {
  return !output.isTechnicalEscalation && output.normalizedProblemStatement !== null;
}

/**
 * Guarantees that a thread judged non-technical never carries a
 * normalizedProblemStatement, so non-technical items can never reach the
 * embeddings/clustering stage later. The prompt asks the model for this too,
 * but clustering safety must not depend on the model complying — this makes
 * it structural.
 *
 * affectedSystem and issueTypeHint are deliberately left untouched: they stay
 * useful as metadata on non-technical items, and neither is embedded.
 */
export function enforceNonTechnicalInvariant<T extends EscalationAnalysisLLMOutput>(output: T): T {
  if (!violatesNonTechnicalInvariant(output)) {
    return output;
  }
  return { ...output, normalizedProblemStatement: null };
}

type WorkflowInvariantFields = Pick<
  EscalationAnalysisLLMOutput,
  "isAutomationWorkflowCandidate" | "normalizedWorkflowStatement" | "workflowClassification"
>;

/** True when a non-workflow item carries workflow fields it should not have. */
export function violatesWorkflowInvariant(output: WorkflowInvariantFields): boolean {
  return (
    !output.isAutomationWorkflowCandidate &&
    (output.normalizedWorkflowStatement !== null || output.workflowClassification !== null)
  );
}

/**
 * Mirror of the technical invariant, for the workflow track: a thread not
 * judged a repeatable manual workflow never carries a workflow statement or
 * classification, so it can never enter the workflow embedding pool.
 *
 * Blank statements are normalised to null so downstream code never treats ""
 * as an embeddable statement.
 */
export function enforceWorkflowInvariant<T extends EscalationAnalysisLLMOutput>(output: T): T {
  if (violatesWorkflowInvariant(output)) {
    return { ...output, normalizedWorkflowStatement: null, workflowClassification: null };
  }
  if (
    output.isAutomationWorkflowCandidate &&
    output.normalizedWorkflowStatement !== null &&
    output.normalizedWorkflowStatement.trim() === ""
  ) {
    return { ...output, normalizedWorkflowStatement: null };
  }
  return output;
}

/**
 * Applies every cross-field invariant. The two tracks are enforced
 * independently, so a thread that is both a defect and a manual workflow keeps
 * both statements, and a thread that is neither keeps neither.
 */
export function enforceAnalysisInvariants<T extends EscalationAnalysisLLMOutput>(output: T): T {
  return enforceWorkflowInvariant(enforceNonTechnicalInvariant(output));
}
