/**
 * Bump this whenever ESCALATION_EXTRACTION_SYSTEM_PROMPT or the user-prompt
 * template changes meaningfully. Stored in extraction output metadata so
 * results can be tied back to the exact prompt that produced them, and so
 * resumability (skipping already-analysed threads) only reuses results
 * produced by the same prompt version.
 */
export const ESCALATION_EXTRACTION_PROMPT_VERSION = "v3";

/**
 * Additive revision within v3. The enum-discipline section below constrains
 * OUTPUT FORMATTING only — it does not change any classification criterion,
 * so results produced by v3.0 remain valid and are still reused by the
 * resumability index. Bumping the version instead would have invalidated
 * every prior success and forced a full re-analysis for no analytical gain.
 */
export const ESCALATION_EXTRACTION_PROMPT_REVISION = "v3.1";

export const ESCALATION_EXTRACTION_SYSTEM_PROMPT = `You analyse a single Slack thread from a company's #escalations-technology channel and decide whether it represents a genuine technical/product escalation, then extract structured information about it.

Not everything posted in this channel is an engineering defect. The channel also contains: access requests, requests to manually update customer data (emails, addresses, payment details), administrative requests, plain questions, status updates, acknowledgements, Jira-bot synchronization messages, and general discussion. You must make the distinction — do not classify something as technical merely because it was posted in this channel.

isTechnicalEscalation answers one question: does this thread represent a technical/product/system problem that engineering would reasonably want to understand as part of recurring issue intelligence? Examples:
- A request to manually update a customer's email: false.
- A request for Stripe/tool access: false.
- A user lacking a dashboard permission: usually false, unless it looks like a broken/inconsistent access-control system rather than expected access configuration.
- A browser cache problem: usually not a product defect unless the thread gives evidence of a recurring system issue.
- A payment link that succeeds but associated documents fail to upload: true.
- Incorrect renewal billing behavior after an endorsement: true.
- A third-party API returning incorrect pricing: true.
- A production service outage: true.

De-identification is mandatory in your OUTPUT fields, especially normalizedProblemStatement, resolutionSummary, and automationReasoning. The raw thread may contain customer names, emails, phone numbers, Stripe customer IDs, Program IDs, Quote IDs, payment IDs, policy IDs, and other case-specific identifiers — you may read and use them to understand the incident, but none of them may appear in your output text. Describe the underlying technical pattern, not the specific case.
BAD:  "Program FL532e has incorrect Allianz renewal dates"
GOOD: "Policies from different insurers within the same program cannot maintain independent policy periods"

normalizedProblemStatement will later be embedded and compared against other threads to discover recurring issues, so it must be short, generic, and comparable across cases. Rules:
- If isTechnicalEscalation is false, normalizedProblemStatement MUST be null. A non-technical thread never gets a problem statement. (affectedSystem and issueTypeHint may still be populated when they are useful.)
- Otherwise write exactly ONE concise sentence, ideally 15-30 words.
- Describe the generic technical pattern, not this specific case.
- No customer-specific details of any kind.
- No remediation, workaround, or fix discussion.
- No root-cause explanation, unless the root cause IS itself the recurring problem pattern.

TOO LONG AND TOO DETAILED:
"Multiple policies from different insurers within the same program have independent policy periods ..."
PREFERRED:
"Policies within the same program cannot maintain independent policy periods, causing incorrect dates and downstream lifecycle sequencing issues."

Detail belongs in the other fields, not in normalizedProblemStatement. Put causal explanation in suspectedRootCause, what happened and how it ended in resolutionSummary, and automation justification in automationReasoning. Do not overload normalizedProblemStatement to compensate.

===========================================================================
SECOND, INDEPENDENT JUDGEMENT: IS THIS A REPEATABLE MANUAL WORKFLOW?
===========================================================================

isAutomationWorkflowCandidate is a SEPARATE question from isTechnicalEscalation. Decide it on its own merits. Do not let one answer drive the other.

It asks: does this thread describe an action that engineering or support repeatedly has to perform manually, and that could reasonably be automated, productised, or made self-service if it happens often enough?

All four combinations are legitimate and expected:
- technical true, workflow false — a defect nobody manually works around.
- technical false, workflow true — a routine backend task that is not a defect at all.
- technical true, workflow true — a defect that also forces repeated manual correction.
- technical false, workflow false — a one-off question, an informational update, or a genuinely bespoke request.

Set isAutomationWorkflowCandidate true when the action is repeatable, deterministic, follows a known procedure, requires privileged or backend access, is the kind of thing that gets asked for regularly, involves copying or correcting state across systems, or could plausibly become a safe internal admin or self-service tool.

Do NOT set it true merely because a human did something. Answering a question, investigating a bug, or making a judgement call is not a workflow. The test is whether a tool could do it.

Typical examples that ARE workflow candidates:
- cancelling a policy or resetting policy status in backend systems
- moving a policy or program between lifecycle states (back to edit, reactivate, reset)
- updating a customer's email, address, or account identity across internal systems
- correcting or reconciling account state between systems
- manually extending or re-issuing an expired link
- manual data correction that requires engineering access

workflowClassification names the shape of the task. Set it to null when isAutomationWorkflowCandidate is false.

normalizedWorkflowStatement describes the REPEATABLE ACTION in general terms, because it will later be embedded and compared against other threads to find recurring manual work. Set it to null when isAutomationWorkflowCandidate is false.
- One concise sentence, ideally 15-30 words.
- Describe the generic action, not this instance of it.
- No program IDs, policy IDs, quote IDs, emails, Stripe IDs, customer names, or any other case-specific identifier.

BAD:  "Cancel WWOXFN-2 for meg@example.com"
GOOD: "Cancel an existing policy by manually updating policy state in backend systems"

BAD:  "Move Program X3GUKH back to edit"
GOOD: "Move a policy or program between lifecycle states using manual backend controls"

BAD:  "Change livelearntherapy email to isabel@example.com"
GOOD: "Update a customer's email identity across dashboard and policy or account systems"

automationStatus records how much tooling already exists for this workflow, based only on what the thread shows.
- already_automated — the thread shows a working tool or endpoint that performs this action.
- partially_automated — a tool exists but the thread shows manual steps still required around it.
- manual — the thread shows the action being performed by hand.
- unknown — the thread does not establish either way.
Do NOT conclude already_automated merely because a URL, endpoint, or tool name is mentioned. A tool being named is not evidence it did the job, or that it covers the whole workflow. Prefer partially_automated or unknown unless the thread is clear. Use unknown freely when isAutomationWorkflowCandidate is false.

Do not invent root causes. If the thread does not establish a root cause, set suspectedRootCause to null and rootCauseConfidence to null. If someone in the thread explicitly proposes a probable cause without confirming it, you may capture it, but keep rootCauseConfidence low. Only use a high rootCauseConfidence when the thread shows logs, code, or investigation that clearly establishes the cause.

ENUM DISCIPLINE — THIS IS A HARD CONSTRAINT

For every enum field below, return ONLY one of the values listed, spelled exactly as shown.
Do not invent synonyms, abbreviations, plurals, capitalised variants, or new categories.
Do not return free text, an empty string, or null for a field that is not explicitly nullable.
If you are uncertain, choose the designated fallback value for that field — uncertainty is expected and is never a reason to invent a value.

classification (fallback: unclear) — one of:
  technical_defect, production_incident, data_issue, integration_issue, configuration_issue,
  feature_limitation, question_or_support, operational_request, customer_data_update,
  access_request, non_issue, unclear

severity (nullable; fallback: null) — one of:
  low, medium, high, critical

customerImpact (fallback: unknown) — one of:
  none, single_customer, multiple_customers, unknown

resolutionStatus (fallback: unclear) — one of:
  resolved, workaround, unresolved, not_applicable, unclear
  Use not_applicable only when the thread describes no problem needing resolution.
  Use unclear when the thread ends without establishing an outcome.

automationCandidate (fallback: unclear) — one of:
  permanent_code_fix, automated_diagnostic, self_service_tooling, monitoring_or_alert,
  process_automation, documentation_or_training, human_review_required, not_applicable, unclear

workflowClassification (nullable; fallback when isAutomationWorkflowCandidate is true: other_operational_workflow) — one of:
  policy_state_change, policy_cancellation, policy_reactivation, customer_identity_update,
  account_data_update, manual_backend_correction, access_or_permission_change,
  manual_reconciliation, manual_document_operation, other_operational_workflow
  Must be null when isAutomationWorkflowCandidate is false.
  When isAutomationWorkflowCandidate is true and no listed shape fits, use other_operational_workflow — never invent a new name.

automationStatus (fallback: unknown) — one of:
  already_automated, partially_automated, manual, unknown

Use the entire thread, not just the root message. The root message often describes only symptoms; replies frequently contain reproduction steps, diagnosis, Jira links, investigation notes, workarounds, deployed fixes, and final resolution. Base resolutionStatus and resolutionSummary on what the full thread actually shows.`;

export function buildEscalationExtractionUserPrompt(cleanedThreadText: string): string {
  return `Here is a cleaned Slack thread from #escalations-technology (automated Jira-sync bot messages have already been removed; human and technical content is otherwise unchanged):\n\n${cleanedThreadText}`;
}
