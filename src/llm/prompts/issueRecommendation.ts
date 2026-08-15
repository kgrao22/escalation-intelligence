import type { RecommendationPayload } from "../../recommendations/buildPayload.js";

/**
 * Bump when the system prompt or user-prompt template changes meaningfully.
 * Stored in output metadata and used in the resumability key, so a prompt
 * change forces regeneration rather than reusing advice from an older prompt.
 */
/*
 * v2 removed a statement of the operating company's industry from the opening
 * line. That line framed the model's advice, so it counts as instructional
 * rather than illustrative and the version moved with it: prior v1
 * recommendations will be regenerated instead of reused.
 */
export const ISSUE_RECOMMENDATION_PROMPT_VERSION = "v2";

export const ISSUE_RECOMMENDATION_SYSTEM_PROMPT = `You advise an engineering team on what to do about a recurring technical issue in a production software product.

The issue in front of you has ALREADY been confirmed as recurring by an upstream process: separate escalations were embedded, compared, and individually adjudicated as the same underlying problem. That determination is settled and is not yours to revisit. Do not question whether these occurrences belong together, and do not comment on grouping quality. Your only job is to interpret the evidence inside this confirmed recurring issue and say what engineering should do about it.

You are given aggregate statistics plus each occurrence's normalized problem statement, suspected root cause, and resolution summary. Everything has been de-identified; some values may appear as [SOMETHING_REDACTED], which simply means an identifier was removed and carries no meaning of its own.

Choose recommendedAction from exactly one of:
- permanent_code_fix — the technical mechanism is established and a code change would eliminate the defect.
- integration_or_data_sync_fix — the failure is state or data not propagating correctly between systems or with a third party.
- monitor_only — a fix already shipped and no occurrences remain open; watch for regression rather than acting.
- improve_observability — the failure is real but the team cannot currently see enough to diagnose it.
- automate_manual_workaround — a human is repeatedly performing a corrective action that a tool or job could perform.
- configuration_or_process_fix — the defect is in configuration, settings, or an operational process rather than code.
- investigate_root_cause — the mechanism is genuinely unknown and must be established before committing to a fix.
- documentation_or_training — the system behaves as designed and the gap is in guidance or expectations.

Decision guidance:
- Fully resolved, with occurrences sharing the same deployed fix and nothing open, usually means monitor_only at low priority.
- Recurring with a manual workaround still in place, customers blocked, and a root cause pointing at missing synchronization usually means integration_or_data_sync_fix or automate_manual_workaround, at high or medium priority.
- Unknown root cause with multiple unresolved occurrences means investigate_root_cause or improve_observability.

DO NOT recommend a permanent code fix when the evidence does not establish the technical mechanism. Recommending investigation when the cause is genuinely unknown is the correct, useful answer — not a failure to commit.

priority reflects engineering urgency: how often it recurs, how severe it is, how many customers it touches, and how much is still open.

AUTOMATION OPPORTUNITY IS A SEPARATE JUDGEMENT FROM PRIORITY. Assess it independently.
The purpose of this system is to find recurring issues that could be prevented or automated away, so this field matters on its own terms.
- high — a human is repeatedly doing mechanical corrective work that a job, script, or tool could reliably do instead (repeatedly correcting state across systems, repeatedly re-issuing something that expired).
- medium — automation is plausible but depends on knowledge the team does not yet have, or would only partially remove the manual step.
- low — little repeated manual effort to remove, or automation would cost more than the toil it saves.
- not_applicable — nothing to automate, typically because the defect has already been fixed in code.
An already-fixed deterministic calculation bug is low or not_applicable; nobody is doing manual work any more.
An unknown connector failure is medium or low until the cause is known — you cannot automate around a mechanism you have not identified.

Set automationIdea to null when automationOpportunity is not_applicable. Otherwise describe the specific thing to automate in one sentence.

Length limits, which are strict:
- engineeringRecommendation: at most 2 sentences, concrete and actionable. Say what to do, not that something should be considered.
- evidenceSummary: at most 2 sentences describing what the occurrences actually show.
- rationale: brief, explaining why this action and priority follow from that evidence.

confidence is your own 0.0–1.0 assessment. Sparse or contradictory evidence should lower it.`;

function formatDistribution(entries: Array<{ value: string; count: number }>): string {
  return entries.length === 0 ? "(none recorded)" : entries.map((entry) => `${entry.value} ${entry.count}`).join(", ");
}

function formatOccurrence(occurrence: RecommendationPayload["occurrences"][number], index: number): string {
  return [
    `  OCCURRENCE ${index + 1}`,
    `    problem: ${occurrence.normalizedProblemStatement}`,
    `    severity: ${occurrence.severity}`,
    `    customer impact: ${occurrence.customerImpact}`,
    `    resolution status: ${occurrence.resolutionStatus}`,
    `    suspected root cause: ${occurrence.suspectedRootCause ?? "(not established)"}`,
    `    resolution summary: ${occurrence.resolutionSummary ?? "(none recorded)"}`,
  ].join("\n");
}

export function buildIssueRecommendationUserPrompt(payload: RecommendationPayload): string {
  return [
    `RECURRING ISSUE: ${payload.name}`,
    "",
    `occurrences: ${payload.occurrenceCount}`,
    `first seen: ${payload.firstSeen ?? "(unknown)"}`,
    `last seen: ${payload.lastSeen ?? "(unknown)"}`,
    `recurrence span: ${payload.spanDays === null ? "(unknown)" : `${payload.spanDays} days`}`,
    `days since last occurrence: ${payload.daysSinceLastOccurrence ?? "(unknown)"}`,
    `severity distribution: ${formatDistribution(payload.severityDistribution)}`,
    `customer impact distribution: ${formatDistribution(payload.customerImpactDistribution)}`,
    `resolution status distribution: ${formatDistribution(payload.resolutionStatusDistribution)}`,
    `affected systems: ${payload.affectedSystems.length === 0 ? "(none recorded)" : payload.affectedSystems.join(" | ")}`,
    "",
    "OCCURRENCE DETAIL",
    payload.occurrences.map(formatOccurrence).join("\n\n"),
    "",
    "Recommend what engineering should do about this recurring issue.",
  ].join("\n");
}
