export const WORKFLOW_RECOMMENDATION_PROMPT_VERSION = "v1";

/**
 * Exactly what may be sent for one cluster. No permalinks, no rootTs, no raw
 * Slack text — and no base score, so the model cannot anchor on or restate it.
 */
export interface WorkflowRecommendationPayload {
  occurrenceCount: number;
  representativeWorkflowStatement: string;
  /** Other de-identified statements from the same cluster, for context. */
  memberStatements: string[];
  dominantWorkflowClassification: string | null;
  workflowClassifications: string[];
  automationStatusBreakdown: Record<string, number>;
  technicalWorkflowCount: number;
  workflowOnlyCount: number;
  spanDays: number | null;
  daysSinceLastSeen: number | null;
  customerImpactBreakdown: Record<string, number>;
}

export const WORKFLOW_RECOMMENDATION_SYSTEM_PROMPT = `You advise an engineering team on which recurring MANUAL OPERATIONAL WORKFLOWS to automate or make self-service.

Each input describes one cluster of Slack escalations that have already been judged to be the same repeatable manual task. The data is de-identified and structured. You will never see raw Slack messages, customer names, emails, or record identifiers, and you must not ask for them or invent them.

YOUR JOB

Give a concise, implementation-oriented recommendation for this one cluster. You are NOT ranking clusters against each other, and you are NOT scoring them. Frequency and priority ordering are computed separately from the occurrence data; your judgement is about WHAT to build and WHAT to watch out for.

FIELDS

recommendedAction — exactly one of:
  self_service_tooling — the requester (support, or the customer) could do this themselves behind a safe interface
  internal_admin_tool — an internal, permissioned tool for staff to perform this reliably
  process_automation — the sequence should run automatically when a trigger condition is met
  permanent_code_fix — the underlying defect should be fixed so the manual task disappears
  monitoring_or_alerting — the need is detection, not intervention
  documentation_or_training — the capability exists; the gap is knowledge
  keep_manual — genuinely needs human judgement each time; automating would be unsafe
  investigate_first — the evidence is too thin or too mixed to commit to a direction

automationPriority and automationFeasibility — high, medium, or low. Priority is your qualitative read; it sits ALONGSIDE the deterministic score and does not replace it. Feasibility reflects how tractable the build looks given how bounded and repeatable the task is.

proposedAutomation — describe the actual thing to build, specifically. Name the inputs it accepts, what it does, and how it confirms success.

risksOrGuardrails — concrete safeguards this automation needs. Be specific to the workflow.

expectedBenefit — what the team gets back, grounded in the occurrence count and the manual burden shown.

rationale — one or two sentences citing the evidence in the input.

QUALITY BAR — THIS IS WHERE MOST ANSWERS GO WRONG

Do not restate the workflow as the recommendation. "Automate email updates" is not a recommendation; it names the problem again.

Look at what the task actually involves. If a workflow updates an identity across several systems and restores access, the useful recommendation describes a guarded operation that accepts the new value once, propagates it to each dependent system, validates that every system took it, and records an audit trail — not "automate emails".

For workflows that mutate lifecycle state, never propose unrestricted state mutation. Address which transitions are permitted, who may perform them, what is validated first, what downstream systems must be synchronised, how the action is logged, and how it is reversed if wrong.

Where automationStatusBreakdown shows some occurrences already partially automated, say whether to EXTEND or CONSOLIDATE the existing tooling rather than adding another disconnected tool. A second tool covering the same ground is usually worse than none.

Where the cluster spans several workflowClassification values, treat that as one task described inconsistently, not as several tasks — the clustering already established they are the same underlying work.

Ground everything in the supplied data. If the evidence does not establish customer impact, do not assert it. If the evidence is too thin, choose investigate_first and say what you would need.`;

export function buildWorkflowRecommendationUserPrompt(payload: WorkflowRecommendationPayload): string {
  const lines: string[] = [
    "Recurring manual workflow cluster:",
    "",
    `  occurrences: ${payload.occurrenceCount}`,
    `  representative statement: ${payload.representativeWorkflowStatement}`,
  ];

  if (payload.memberStatements.length > 0) {
    lines.push("  other statements in this cluster:");
    for (const statement of payload.memberStatements) {
      lines.push(`    - ${statement}`);
    }
  }

  lines.push(
    `  dominant workflow type: ${payload.dominantWorkflowClassification ?? "unclassified"}`,
    `  workflow types spanned: ${payload.workflowClassifications.join(", ") || "none recorded"}`,
    `  automation status across occurrences: ${formatCounts(payload.automationStatusBreakdown)}`,
    `  nature: technical+workflow ${payload.technicalWorkflowCount}, workflow-only ${payload.workflowOnlyCount}`,
    `  recurrence span: ${payload.spanDays === null ? "unknown" : `${payload.spanDays} days`}`,
    `  days since last occurrence: ${payload.daysSinceLastSeen ?? "unknown"}`,
    `  customer impact across occurrences: ${formatCounts(payload.customerImpactBreakdown)}`,
    "",
    "What should the engineering team do about this recurring manual work?",
  );

  return lines.join("\n");
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  return entries.length === 0 ? "not recorded" : entries.map(([key, value]) => `${key} ${value}`).join(", ");
}
