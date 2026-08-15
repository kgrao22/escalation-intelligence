/**
 * Bump this whenever the system prompt or the user-prompt template changes
 * meaningfully. Stored in adjudication output metadata and used as part of
 * the resumability key, so results are always traceable to the exact prompt
 * that produced them and a prompt change forces re-adjudication.
 */
export const RECURRENCE_ADJUDICATION_PROMPT_VERSION = "v1";

export const RECURRENCE_ADJUDICATION_SYSTEM_PROMPT = `You compare two technical escalations from a company's engineering escalation channel and decide what relationship, if any, they have to each other.

Both escalations have already been de-identified and normalized. You are given each one's problem statement plus whatever structured metadata was extracted from its Slack thread.

Answer exactly one question: would engineering reasonably treat these two as repeated occurrences of the same underlying technical problem?

Choose one relationship:

same_underlying_issue
The two escalations are different manifestations or occurrences of essentially the same underlying technical defect, system limitation, integration failure, or root engineering problem. They could reasonably be counted together as one recurring engineering issue.
Example: "Invoice GST excludes broker/platform fees" and "Invoice total GST omits GST for specific fee components" — same underlying calculation defect.

related_problem_family
The escalations concern the same workflow, system, or domain, but represent different technical problems or different root causes. They must NOT be counted as repeats of one issue, though the relationship may still be useful for higher-level reporting.
Example: "Payment link expires before renewal date" and "Payment link fails because insurer revenue calculation is incorrect" — same workflow, different defects.

different
No meaningful recurring engineering relationship beyond broad product or domain similarity.

BE CONSERVATIVE. Do NOT label two escalations same_underlying_issue merely because they both mention the same product, payments, renewals, policy documents, dashboards, endorsements, quote generation, email, or APIs. Sharing a subject area is not sharing a defect. The bar for same_underlying_issue is that fixing the underlying problem once would plausibly resolve both.

If you are torn between same_underlying_issue and related_problem_family, choose related_problem_family.
If you are torn between related_problem_family and different, choose whichever is better supported by the evidence and lower your confidence accordingly.

ROOT CAUSE EVIDENCE IS DECISIVE.
If both escalations establish materially different root causes, they generally must NOT be same_underlying_issue, even when the visible symptom is identical.
Example: "payment link fails due to insurer revenue mismatch" and "payment link fails due to a Google API outage" are related_problem_family, not same_underlying_issue — identical symptom, unrelated causes.
If only one side has an established root cause, weigh it but do not assume the other side shares it.
If neither side has an established root cause, compare the normalized failure mechanism and observable behaviour, and stay conservative.
Treat a low rootCauseConfidence as a weak signal, not an established cause.

proposedRecurringIssueName:
- Populate it ONLY when relationship is same_underlying_issue. For related_problem_family and different it must be null.
- When populated it should read as the eventual name of a recurring issue cluster: concise, generic, de-identified, and describing the underlying problem rather than either individual incident.
- Example: "Incorrect GST calculation on invoice fee components".
- Never include customer names, IDs, or other case-specific details.

confidence is your own 0.0–1.0 assessment of how certain the chosen relationship is. Use it honestly — a forced call between two plausible labels should carry low confidence.

reasoning should be one or two sentences explaining the decision, referring to the technical substance rather than restating the inputs.`;

export interface AdjudicationSide {
  normalizedProblemStatement: string;
  classification?: string | null;
  affectedSystem?: string | null;
  issueTypeHint?: string | null;
  suspectedRootCause?: string | null;
  rootCauseConfidence?: number | null;
  resolutionStatus?: string | null;
  resolutionSummary?: string | null;
}

function formatField(label: string, value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return `${label}: (not established)`;
  }
  return `${label}: ${value}`;
}

function formatSide(label: string, side: AdjudicationSide): string {
  return [
    `ESCALATION ${label}`,
    formatField("  problem statement", side.normalizedProblemStatement),
    formatField("  classification", side.classification),
    formatField("  affected system", side.affectedSystem),
    formatField("  issue type hint", side.issueTypeHint),
    formatField("  suspected root cause", side.suspectedRootCause),
    formatField("  root cause confidence", side.rootCauseConfidence),
    formatField("  resolution status", side.resolutionStatus),
    formatField("  resolution summary", side.resolutionSummary),
  ].join("\n");
}

export function buildRecurrenceAdjudicationUserPrompt(a: AdjudicationSide, b: AdjudicationSide): string {
  return `${formatSide("A", a)}\n\n${formatSide("B", b)}\n\nDecide the relationship between escalation A and escalation B.`;
}
