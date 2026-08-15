import type { ReviewArtifact } from "../persistence/reviewArtifactOutput.js";
import { EXPECTED_DESTINATION_CHANNEL_ID } from "../slackPublishing/safety.js";
import { reviewTitle } from "../review/displayNames.js";
import {
  describeAutomationStatus,
  formatSystems,
  slackDisplayTitle,
  truncateForSlack,
} from "./presentation.js";
import {
  assertNoUnsupportedExtrapolation,
  buildSlackSafeBenefit,
  describeWorkflowCandidates,
} from "./slackSafeCopy.js";

/** One parent plus exactly four section replies — never one reply per issue. */
export const REVIEW_REPLY_SECTIONS = [
  "Automation opportunities",
  "Recurring manual workflows",
  "Recurring technical issues",
  "Recommended next actions",
] as const;

export interface ReviewPreviewMessage {
  /** 1 is the parent; 2..5 are thread replies, in posting order. */
  index: number;
  kind: "parent" | "reply";
  title: string;
  text: string;
}

export interface ReviewPreviewArtifact {
  metadata: {
    reviewInputFile: string;
    windowTag: string;
    generatedAt: string;
    /** Encoded here and re-validated by the publisher. */
    destinationChannelId: string;
    messageCount: number;
    /** Distinguishes this from the legacy 90-day slack-preview format. */
    previewFormat: "review-v1";
  };
  summary: {
    threadsAnalysed: number;
    technicalEscalations: number;
    workflowCandidates: number;
    recurringWorkflowClusters: number;
    singletonWorkflows: number;
    highPriorityHighFeasibility: number;
    coverageFrom: string | null;
    coverageTo: string | null;
  };
  messages: ReviewPreviewMessage[];
}

function day(value: string | null): string {
  return value ? value.slice(0, 10) : "?";
}

function links(evidenceLinks: string[]): string {
  return evidenceLinks.length === 0
    ? ""
    : `Evidence: ${evidenceLinks.map((link, i) => `<${link}|${i + 1}>`).join(" ")}`;
}

function buildParent(review: ReviewArtifact, highBoth: number): string {
  const o = review.overview;
  const t = review.technicalIssues;
  const lines = [
    `*${reviewTitle(o.windowDays)}*`,
    `_${day(o.coverageFrom)} to ${day(o.coverageTo)}_`,
    "",
    "Across a year of escalations, two things keep recurring: product defects that resurface,",
    "and manual operational work the technology team is repeatedly asked to perform by hand.",
    "",
    `• *${o.threadsAnalysed}* escalations analysed`,
    `• *${o.technicalEscalations}* technical → *${t.totalRecurringIssues ?? 0}* recurring patterns, *${t.totalOccurrences ?? 0}* occurrences, *${t.totalOpenOccurrences ?? 0}* still open`,
    `• *${o.workflowCandidates}* workflow candidates → *${o.recurringWorkflowClusters}* recurring manual workflows, ${o.singletonWorkflows} one-off`,
    `• *${highBoth}* opportunities rated both high priority and high feasibility`,
  ];

  const top = review.automationOpportunities.slice(0, 3);
  if (top.length > 0) {
    lines.push("", "*Most repeated manual work*");
    for (const opportunity of top) {
      lines.push(`${opportunity.rank}. ${shortTitle(opportunity)} — ${opportunity.occurrenceCount}x`);
    }
  }

  lines.push("", "Detail, evidence and recommended actions in thread.");
  return lines.join("\n");
}

/**
 * Prefers a specific classification label; derives one from the workflow
 * statement when the label is a generic bucket, so two clusters never render
 * with the same title.
 */
function shortTitle(item: {
  title: string;
  classificationKey?: string | null;
  representativeStatement?: string;
}): string {
  const label = (item.title.split(" — ")[0] ?? item.title).trim();
  return slackDisplayTitle(label, item.classificationKey ?? null, item.representativeStatement ?? "");
}

/** First complete sentence, abbreviation-safe, capped for Slack. */
function firstSentence(text: string, max: number): string {
  const trimmed = truncateForSlack(text, max);
  const stop = /^[^.]*?\.(?=\s|$)/.exec(trimmed);
  return (stop?.[0] ?? trimmed).trim();
}

/** Decision buckets: build it, fix the product, or find out more first. */
const ACTION_BUCKETS: ReadonlyArray<{ heading: string; actions: string[]; limit: number }> = [
  {
    heading: "A. Automate / build tooling",
    actions: ["internal_admin_tool", "self_service_tooling", "process_automation"],
    limit: 4,
  },
  { heading: "B. Fix root cause in the product", actions: ["permanent_code_fix"], limit: 3 },
  {
    heading: "C. Investigate first",
    actions: ["investigate_first", "monitor_or_alerting", "documentation_or_training", "keep_manual"],
    limit: 3,
  },
];

function buildOpportunities(review: ReviewArtifact): string {
  if (review.automationOpportunities.length === 0) {
    return "*Automation opportunities*\n\nNo recurring workflow qualified for ranking in this period.";
  }

  const lines = ["*Automation opportunities*", ""];
  for (const bucket of ACTION_BUCKETS) {
    const selected = review.automationOpportunities
      .filter((o) => o.recommendedAction !== null && bucket.actions.includes(o.recommendedAction))
      .slice(0, bucket.limit);
    if (selected.length === 0) {
      continue;
    }
    const total = review.automationOpportunities.filter(
      (o) => o.recommendedAction !== null && bucket.actions.includes(o.recommendedAction),
    ).length;
    lines.push(`*${bucket.heading}*${total > selected.length ? ` — showing ${selected.length} of ${total}` : ""}`);
    lines.push("");
    lines.push(renderOpportunityGroup(review, selected));
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function renderOpportunityGroup(
  review: ReviewArtifact,
  opportunities: ReviewArtifact["automationOpportunities"],
): string {
  const lines: string[] = [];
  for (const opportunity of opportunities) {
    const workflow = review.recurringWorkflows.find((w) => w.clusterId === opportunity.clusterId);
    const status = describeAutomationStatus(
      workflow?.automationStatusBreakdown ?? {},
      opportunity.occurrenceCount,
    );

    lines.push(`*${shortTitle(opportunity)}*`);
    lines.push(`${opportunity.occurrenceCount} occurrences · ${status}`);
    if (opportunity.proposedAutomation) {
      // One sentence only. Implementation guardrails stay in the artifact.
      lines.push(`→ ${firstSentence(opportunity.proposedAutomation, 165)}`);
    }
    const evidence = links(opportunity.evidenceLinks.slice(0, 2));
    if (evidence) {
      lines.push(evidence);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function buildWorkflows(review: ReviewArtifact): string {
  if (review.recurringWorkflows.length === 0) {
    return "*Recurring manual workflows*\n\nNo workflow recurred more than once in this period.";
  }

  const shown = review.recurringWorkflows.slice(0, 6);
  const lines = [
    "*Recurring manual workflows*",
    `_Work the technology team was asked to perform by hand. ${review.recurringWorkflows.length} patterns recurred; showing the ${shown.length} most frequent._`,
    "",
  ];
  for (const workflow of shown) {
    const status = describeAutomationStatus(workflow.automationStatusBreakdown, workflow.occurrenceCount);
    lines.push(
      `• *${shortTitle({ title: workflow.title, classificationKey: workflow.classificationKey, representativeStatement: workflow.representativeStatement })}* — ${workflow.occurrenceCount}x · ${status} · ${day(workflow.firstSeen)} to ${day(workflow.lastSeen)}`,
    );
  }

  const persisted = buildPersistence(review);
  if (persisted.length > 0) {
    lines.push("", "*Patterns that persisted*");
    lines.push(...persisted);
  }

  return lines.join("\n").trimEnd();
}

/**
 * Time perspective derived strictly from first/last occurrence dates. The
 * wording is deliberately "observed across N days" — the evidence shows when a
 * pattern reappeared, never that it occurred continuously.
 */
function buildPersistence(review: ReviewArtifact): string[] {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const spans = review.recurringWorkflows
    .map((workflow) => {
      if (!workflow.firstSeen || !workflow.lastSeen) {
        return null;
      }
      const start = Date.parse(workflow.firstSeen);
      const end = Date.parse(workflow.lastSeen);
      if (Number.isNaN(start) || Number.isNaN(end)) {
        return null;
      }
      return {
        title: shortTitle({
          title: workflow.title,
          classificationKey: workflow.classificationKey,
          representativeStatement: workflow.representativeStatement,
        }),
        days: Math.round((end - start) / MS_PER_DAY),
        occurrences: workflow.occurrenceCount,
      };
    })
    .filter((entry): entry is { title: string; days: number; occurrences: number } => entry !== null)
    .filter((entry) => entry.days >= 90)
    .sort((a, b) => b.days - a.days || b.occurrences - a.occurrences)
    .slice(0, 5);

  return spans.map(
    (entry) =>
      `• ${entry.title} — observed across ${entry.days} days (${entry.occurrences} occurrences)` +
      `${entry.occurrences <= 2 ? ", though at low frequency" : ""}.`,
  );
}

function buildTechnical(review: ReviewArtifact): string {
  const t = review.technicalIssues;
  if (!t.available) {
    return `*Recurring technical issues*\n\n${t.message}`;
  }

  const lines = ["*Recurring technical issues*"];
  if (t.totalRecurringIssues && t.totalRecurringIssues > t.issues.length) {
    lines.push(
      `_Showing the ${t.issues.length} strongest of ${t.totalRecurringIssues} patterns, covering ${t.totalOccurrences ?? 0} occurrences (${t.totalOpenOccurrences ?? 0} still open)._`,
    );
  }
  lines.push("");

  for (const issue of t.issues) {
    const state = issue.fullyResolved ? "all resolved" : `${issue.openOccurrences} still open`;
    lines.push(`*${issue.name}*`);
    lines.push(`${issue.occurrenceCount} occurrences · ${state}`);
    if (issue.remediation) {
      // What Engineering should FIX — not which systems appeared.
      lines.push(`→ ${firstSentence(issue.remediation, 140)}`);
    }
    const evidence = links(issue.evidenceLinks.slice(0, 2));
    if (evidence) {
      lines.push(evidence);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function buildNextActions(review: ReviewArtifact): string {
  const BUILD = ["internal_admin_tool", "self_service_tooling", "process_automation"];
  const FIX = ["permanent_code_fix"];

  const pick = (actions: string[], limit: number) =>
    review.automationOpportunities
      .filter((o) => o.recommendedAction !== null && actions.includes(o.recommendedAction))
      .slice(0, limit);

  const lines = ["*Recommended next actions*", ""];

  const sections: Array<[string, ReviewArtifact["automationOpportunities"]]> = [
    ["BUILD", pick(BUILD, 3)],
    ["FIX", pick(FIX, 3)],
    ["INVESTIGATE", pick(["investigate_first"], 2)],
  ];

  let order = 0;
  for (const [heading, items] of sections) {
    if (items.length === 0) {
      continue;
    }
    lines.push(`*${heading}*`);
    for (const item of items) {
      order += 1;
      lines.push(`${order}. ${shortTitle(item)} — ${item.occurrenceCount} occurrences`);
    }
    lines.push("");
  }

  const { longTail } = review;
  lines.push(`*Long tail:* ${longTail.singletonWorkflowCount} workflows occurred only once and are not ranked.`);
  if (longTail.topClassifications.length > 0) {
    lines.push(
      `Most common areas: ${longTail.topClassifications.slice(0, 3).map((e) => `${e.label} (${e.count})`).join(", ")}.`,
    );
  }
  lines.push(
    "_Grouping favours precision: threads without direct matching evidence stay outside a recurring pattern rather than being merged in._",
  );
  return lines.join("\n").trimEnd();
}

export function buildReviewPreview(
  review: ReviewArtifact,
  reviewInputFile: string,
  generatedAt: Date,
): ReviewPreviewArtifact {
  const highBoth = review.automationOpportunities.filter(
    (opportunity) => opportunity.priority === "high" && opportunity.feasibility === "high",
  ).length;

  const bodies = [
    buildOpportunities(review),
    buildWorkflows(review),
    buildTechnical(review),
    buildNextActions(review),
  ];

  const messages: ReviewPreviewMessage[] = [
    { index: 1, kind: "parent", title: reviewTitle(review.overview.windowDays), text: buildParent(review, highBoth) },
    ...REVIEW_REPLY_SECTIONS.map((title, i) => ({
      index: i + 2,
      kind: "reply" as const,
      title,
      text: bodies[i] as string,
    })),
  ];

  // Nothing unsupported may reach a leadership channel.
  for (const message of messages) {
    assertNoUnsupportedExtrapolation(message.text, `Preview message ${message.index} (${message.title})`);
  }

  return {
    metadata: {
      reviewInputFile,
      windowTag: review.metadata.windowTag,
      generatedAt: generatedAt.toISOString(),
      destinationChannelId: EXPECTED_DESTINATION_CHANNEL_ID,
      messageCount: messages.length,
      previewFormat: "review-v1",
    },
    summary: {
      threadsAnalysed: review.overview.threadsAnalysed,
      technicalEscalations: review.overview.technicalEscalations,
      workflowCandidates: review.overview.workflowCandidates,
      recurringWorkflowClusters: review.overview.recurringWorkflowClusters,
      singletonWorkflows: review.overview.singletonWorkflows,
      highPriorityHighFeasibility: highBoth,
      coverageFrom: review.overview.coverageFrom,
      coverageTo: review.overview.coverageTo,
    },
    messages,
  };
}
