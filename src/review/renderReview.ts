import { formatStatusBreakdown, recommendedActionDisplayName, reviewTitle } from "./displayNames.js";
import type { ReviewData } from "./buildReview.js";

/**
 * The eventual Slack shape: one overview message plus four thread replies.
 * Nothing here posts anything — this milestone only renders.
 */
export interface RenderedReview {
  plainText: string;
  slackMrkdwn: {
    overview: string;
    replies: Array<{ title: string; text: string }>;
  };
}


function day(value: string | null): string {
  return value ? value.slice(0, 10) : "?";
}

/** Leadership-facing: no scores, formulas, model names, or pipeline jargon. */
function renderOverviewMessage(review: ReviewData): string {
  const { overview, automationOpportunities } = review;
  const strong = automationOpportunities.filter(
    (opportunity) => opportunity.priority === "high" && opportunity.feasibility === "high",
  ).length;

  const lines = [
    `*${reviewTitle(review.overview.windowDays)}*`,
    "",
    "*Summary:*",
    `• ${overview.threadsAnalysed} escalation threads analysed`,
    `• ${overview.technicalEscalations} technical escalations`,
    `• ${overview.workflowCandidates} manual workflow requests`,
    `• ${overview.recurringWorkflowClusters} recurring manual workflows`,
    `• ${overview.singletonWorkflows} one-off workflows`,
    `• ${strong} high-priority, high-feasibility automation opportunities`,
  ];

  if (overview.coverageFrom && overview.coverageTo) {
    lines.push(`• Coverage: ${day(overview.coverageFrom)} → ${day(overview.coverageTo)}`);
  }

  const top = automationOpportunities.slice(0, 3);
  if (top.length > 0) {
    lines.push("", "*Top automation opportunities:*");
    for (const opportunity of top) {
      lines.push(`${opportunity.rank}. ${opportunity.title} — ${opportunity.occurrenceCount} occurrences`);
    }
  }

  if (!review.technicalIssues.available) {
    lines.push("", `_${review.technicalIssues.message}_`);
  }

  lines.push("", "Details in thread.");
  return lines.join("\n");
}

function renderOpportunities(review: ReviewData): string {
  if (review.automationOpportunities.length === 0) {
    return "*Automation opportunities*\n\nNo recurring workflows qualified for ranking in this window.";
  }

  const lines = ["*Automation opportunities*", ""];
  for (const opportunity of review.automationOpportunities) {
    lines.push(`*${opportunity.rank}. ${opportunity.title}*`);
    lines.push(`${opportunity.occurrenceCount} occurrences · ${recommendedActionDisplayName(opportunity.recommendedAction)}`);
    if (opportunity.priority && opportunity.feasibility) {
      lines.push(`Priority ${opportunity.priority} · feasibility ${opportunity.feasibility}`);
    }
    lines.push(opportunity.patternSummary);
    if (opportunity.proposedAutomation) {
      lines.push(`*Proposal:* ${opportunity.proposedAutomation}`);
    }
    if (opportunity.guardrails.length > 0) {
      lines.push("*Guardrails:*");
      for (const guardrail of opportunity.guardrails) {
        lines.push(`• ${guardrail}`);
      }
    }
    if (opportunity.expectedBenefit) {
      lines.push(`*Benefit:* ${opportunity.expectedBenefit}`);
    }
    if (opportunity.evidenceLinks.length > 0) {
      lines.push(`*Examples:* ${opportunity.evidenceLinks.map((link, i) => `<${link}|${i + 1}>`).join(" ")}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function renderRecurringWorkflows(review: ReviewData): string {
  if (review.recurringWorkflows.length === 0) {
    return "*Recurring manual workflows*\n\nNo workflow recurred more than once in this window.";
  }

  const lines = ["*Recurring manual workflows*", "", "_How often the technology team was asked to do the same task by hand._", ""];
  for (const workflow of review.recurringWorkflows) {
    lines.push(`*${workflow.title}*`);
    lines.push(
      `${workflow.occurrenceCount} occurrences · ${day(workflow.firstSeen)} → ${day(workflow.lastSeen)}`,
    );
    lines.push(`Status: ${formatStatusBreakdown(workflow.automationStatusBreakdown)}`);
    lines.push(
      `${workflow.workflowOnlyCount} operational request${workflow.workflowOnlyCount === 1 ? "" : "s"}, ` +
        `${workflow.technicalWorkflowCount} alongside a technical fault`,
    );
    if (workflow.evidenceLinks.length > 0) {
      lines.push(`*Examples:* ${workflow.evidenceLinks.map((link, i) => `<${link}|${i + 1}>`).join(" ")}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function renderTechnicalIssues(review: ReviewData): string {
  const { technicalIssues } = review;
  if (!technicalIssues.available) {
    return `*Recurring technical issues*\n\n${technicalIssues.message}`;
  }

  const lines = ["*Recurring technical issues*", ""];
  for (const issue of technicalIssues.issues) {
    lines.push(`*${issue.name}*`);
    lines.push(
      `${issue.occurrenceCount} occurrences · ${issue.fullyResolved ? "all resolved" : `${issue.openOccurrences} still open`} · severity ${issue.peakSeverity}`,
    );
    if (issue.affectedSystems.length > 0) {
      lines.push(`Systems: ${issue.affectedSystems.join(", ")}`);
    }
    if (issue.evidenceLinks.length > 0) {
      lines.push(`*Examples:* ${issue.evidenceLinks.map((link, i) => `<${link}|${i + 1}>`).join(" ")}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function renderNextActions(review: ReviewData): string {
  const lines = ["*Recommended next actions*", ""];
  for (const action of review.nextActions) {
    lines.push(`${action.order}. ${action.action}`);
    lines.push(`   _${action.basis}_`);
  }

  const { longTail } = review;
  lines.push("", `*Long tail:* ${longTail.singletonWorkflowCount} workflows occurred only once.`);
  if (longTail.topClassifications.length > 0) {
    lines.push(
      `Most common areas: ${longTail.topClassifications.map((entry) => `${entry.label} (${entry.count})`).join(", ")}`,
    );
  }
  lines.push(longTail.note);
  return lines.join("\n");
}

export function renderReview(review: ReviewData): RenderedReview {
  const replies = [
    { title: "Automation opportunities", text: renderOpportunities(review) },
    { title: "Recurring manual workflows", text: renderRecurringWorkflows(review) },
    { title: "Recurring technical issues", text: renderTechnicalIssues(review) },
    { title: "Recommended next actions", text: renderNextActions(review) },
  ];
  const overview = renderOverviewMessage(review);

  // Plain text mirrors the Slack structure minus mrkdwn markers, so a reader
  // in a terminal sees exactly what would be posted.
  const plainText = [overview, ...replies.map((reply) => reply.text)]
    .join("\n\n---\n\n")
    .replace(/\*/g, "")
    .replace(/<(https?:\/\/[^|>]+)\|([^>]*)>/g, "$1")
    .replace(/_/g, "");

  return { plainText, slackMrkdwn: { overview, replies } };
}
