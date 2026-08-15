import { z } from "zod";

export const RecommendedActionSchema = z.enum([
  "permanent_code_fix",
  "integration_or_data_sync_fix",
  "monitor_only",
  "improve_observability",
  "automate_manual_workaround",
  "configuration_or_process_fix",
  "investigate_root_cause",
  "documentation_or_training",
]);

export const PrioritySchema = z.enum(["high", "medium", "low"]);

export const AutomationOpportunitySchema = z.enum(["high", "medium", "low", "not_applicable"]);

export type RecommendedAction = z.infer<typeof RecommendedActionSchema>;
export type Priority = z.infer<typeof PrioritySchema>;
export type AutomationOpportunity = z.infer<typeof AutomationOpportunitySchema>;

export const RECOMMENDED_ACTIONS: readonly RecommendedAction[] = RecommendedActionSchema.options;
export const PRIORITIES: readonly Priority[] = PrioritySchema.options;
export const AUTOMATION_OPPORTUNITIES: readonly AutomationOpportunity[] = AutomationOpportunitySchema.options;

/**
 * What the LLM generates. `groupId` is excluded on purpose — it is already
 * known locally, so asking the model to echo an identifier it could corrupt
 * buys nothing.
 *
 * The "no automation idea when the opportunity is not applicable" rule is
 * deliberately NOT a Zod `.refine()`: cross-field refinements cannot be
 * expressed in JSON Schema, so `zodOutputFormat` silently drops them — the
 * constraint would never reach the model, yet would still fail client-side
 * validation and turn a usable recommendation into a failure. It is enforced
 * structurally by enforceAutomationIdeaInvariant() instead.
 */
export const IssueRecommendationLLMOutputSchema = z.object({
  recommendedAction: RecommendedActionSchema,
  priority: PrioritySchema,
  engineeringRecommendation: z.string(),
  rationale: z.string(),
  evidenceSummary: z.string(),
  automationOpportunity: AutomationOpportunitySchema,
  automationIdea: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

export type IssueRecommendationLLMOutput = z.infer<typeof IssueRecommendationLLMOutputSchema>;

type AutomationInvariantFields = Pick<
  IssueRecommendationLLMOutput,
  "automationOpportunity" | "automationIdea"
>;

/** True when an issue judged un-automatable still carries an automation idea. */
export function violatesAutomationIdeaInvariant(output: AutomationInvariantFields): boolean {
  return output.automationOpportunity === "not_applicable" && output.automationIdea !== null;
}

/**
 * Keeps `automationIdea` meaningful: absent when automation was judged not
 * applicable, and never an empty string masquerading as a suggestion. A
 * leftover idea on a not_applicable issue would later be rendered as a real
 * automation proposal.
 */
export function enforceAutomationIdeaInvariant<T extends IssueRecommendationLLMOutput>(output: T): T {
  if (violatesAutomationIdeaInvariant(output)) {
    return { ...output, automationIdea: null };
  }
  if (output.automationIdea !== null && output.automationIdea.trim() === "") {
    return { ...output, automationIdea: null };
  }
  return output;
}
