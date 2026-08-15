/** Bumped from v1: the verdict vocabulary and definitions changed materially. */
export const WORKFLOW_ADJUDICATION_PROMPT_VERSION = "v2";

/** Exactly the de-identified fields that may be sent. No rootTs, permalink, or vector. */
export interface WorkflowAdjudicationSide {
  normalizedWorkflowStatement: string;
  workflowClassification: string | null;
  automationStatus: string;
  nature: "technical+workflow" | "workflow-only";
}

export const WORKFLOW_ADJUDICATION_SYSTEM_PROMPT = `You compare two requests from a company's engineering escalation channel and decide whether they describe the same repeatable manual operational task.

Both have already been de-identified and normalized into a description of the ACTION performed, not the customer or case it was performed for. You are judging the task, not the incident.

Return exactly one relationship:

same_underlying_workflow
The two threads represent the same repeatable operational task or the same manual intervention, EVEN IF the wording, the systems named, or the workflowClassification labels differ. What matters is whether one tool, built once, would serve both requests.

Examples of same_underlying_workflow:
- "update customer email across systems" vs "update customer email across dashboard and Stripe"
- "reactivate cancelled policy after payment" vs "move cancelled policy back to active after payment"
- "manually mark policy paid" vs "manually advance payment state to paid"

related_workflow_family
The tasks belong to the same broader operational area but require materially different actions. A tool for one would not perform the other, though they might share a surface or a permission model.

Examples of related_workflow_family:
- "cancel policy" vs "reactivate policy"
- "change customer email" vs "merge duplicate customer accounts"
- "mark policy paid" vs "repair payment amount or sign"

different
The two threads share words, systems, or vocabulary but are operationally distinct tasks.

DECISIVE GUIDANCE

The workflowClassification labels are WEAK EVIDENCE ONLY. They were assigned per-thread without seeing the other thread, and they are frequently inconsistent for genuinely identical tasks. Two threads with DIFFERENT classifications are regularly the same underlying workflow — for example account_data_update and policy_state_change are both used for payment-state transitions, and policy_reactivation and policy_state_change are both used for reactivating a policy.

Never answer "different" merely because the classifications differ. Never answer "same_underlying_workflow" merely because they match. Judge the described action.

The cosine similarity is provided for context only. It reflects wording overlap, not task identity. Two differently-worded descriptions of the same task can score low; two similarly-worded descriptions of distinct tasks can score high. Do not treat a high score as evidence of sameness.

automationStatus and nature are context. A workflow that is partially automated for one thread and manual for another is still the same workflow — differing automation maturity is not a reason to split.

Be conservative about same_underlying_workflow. The bar is that ONE tool, built once, would handle both requests without materially different logic. If one request needs a step the other does not, prefer related_workflow_family.

proposedWorkflowName: for same_underlying_workflow ONLY, give a short, generic, reusable name for the shared task (for example "Update customer email identity across systems"). It must contain no customer names, emails, policy or program identifiers, or other case-specific detail. For related_workflow_family and different, return null.

Give a confidence between 0 and 1 reflecting how certain you are, and one or two sentences of reasoning citing the actions described.`;

function describeSide(label: string, side: WorkflowAdjudicationSide): string {
  return [
    `${label}:`,
    `  workflow: ${side.normalizedWorkflowStatement}`,
    `  workflowClassification: ${side.workflowClassification ?? "unclassified"} (weak evidence only)`,
    `  automationStatus: ${side.automationStatus}`,
    `  nature: ${side.nature}`,
  ].join("\n");
}

export function buildWorkflowAdjudicationUserPrompt(
  a: WorkflowAdjudicationSide,
  b: WorkflowAdjudicationSide,
  similarity: number,
): string {
  return [
    describeSide("Request A", a),
    "",
    describeSide("Request B", b),
    "",
    `Cosine similarity of the two statements: ${similarity.toFixed(4)} (context only — not evidence of task identity)`,
    "",
    "Do these two requests describe the same repeatable manual workflow?",
  ].join("\n");
}
