import { z } from "zod";

export const RecommendedActionSchema = z.enum([
  "self_service_tooling",
  "internal_admin_tool",
  "process_automation",
  "permanent_code_fix",
  "monitoring_or_alerting",
  "documentation_or_training",
  "keep_manual",
  "investigate_first",
]);

export const AutomationPrioritySchema = z.enum(["high", "medium", "low"]);
export const AutomationFeasibilitySchema = z.enum(["high", "medium", "low"]);

export type RecommendedAction = z.infer<typeof RecommendedActionSchema>;
export type AutomationPriority = z.infer<typeof AutomationPrioritySchema>;
export type AutomationFeasibility = z.infer<typeof AutomationFeasibilitySchema>;

/**
 * Deliberately carries NO numeric score and NO rank. Those are computed
 * deterministically before the model is called, and the model is given no
 * field through which it could restate or override them.
 */
export const WorkflowRecommendationLLMOutputSchema = z.object({
  recommendedAction: RecommendedActionSchema,
  automationPriority: AutomationPrioritySchema,
  automationFeasibility: AutomationFeasibilitySchema,
  rationale: z.string(),
  proposedAutomation: z.string(),
  risksOrGuardrails: z.array(z.string()),
  expectedBenefit: z.string(),
});

export type WorkflowRecommendationLLMOutput = z.infer<typeof WorkflowRecommendationLLMOutputSchema>;

export const RECOMMENDED_ACTIONS = RecommendedActionSchema.options;
export const AUTOMATION_PRIORITIES = AutomationPrioritySchema.options;
export const AUTOMATION_FEASIBILITIES = AutomationFeasibilitySchema.options;
