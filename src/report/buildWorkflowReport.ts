import type { RecurringIssueGroup } from "../groups/buildGroups.js";
import type { GroupOutput } from "../persistence/groupOutput.js";
import { distribute, type DistributionEntry } from "./distributions.js";

/**
 * Canonical ordering for automation status, most-manual first — a recurring
 * workflow that is still fully manual is the one worth building a tool for.
 */
export const AUTOMATION_STATUS_ORDER = [
  "manual",
  "partially_automated",
  "already_automated",
  "unknown",
] as const;
export type AutomationStatusBucket = (typeof AUTOMATION_STATUS_ORDER)[number];

const AUTOMATION_STATUS_SET = new Set<string>(AUTOMATION_STATUS_ORDER);

/** Anything absent or unrecognised is "unknown" — never silently "manual". */
export function toAutomationStatusBucket(value: string | null | undefined): AutomationStatusBucket {
  return typeof value === "string" && AUTOMATION_STATUS_SET.has(value)
    ? (value as AutomationStatusBucket)
    : "unknown";
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function diffInDays(from: string, to: string): number | null {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return null;
  }
  return Math.round((end - start) / MS_PER_DAY);
}

export interface WorkflowOccurrence {
  rootTs: string;
  postedAt: string | null;
  permalink: string | null;
  /** The de-identified workflow statement, never the raw Slack text. */
  normalizedWorkflowStatement: string;
  workflowClassification: string | null;
  automationStatus: AutomationStatusBucket;
  affectedSystem: string | null;
}

export interface AnalyzedWorkflow {
  groupId: string;
  name: string | null;
  alternateNames: string[];
  /**
   * How many times this manual workflow was requested. Deliberately a separate
   * field on a separate model from technical defect frequency — the two are
   * never summed.
   */
  occurrenceCount: number;
  consistency: RecurringIssueGroup["consistency"];
  needsReview: boolean;
  firstSeen: string | null;
  lastSeen: string | null;
  spanDays: number | null;
  averageDaysBetweenOccurrences: number | null;
  daysSinceLastOccurrence: number | null;
  affectedSystems: string[];
  workflowClassifications: string[];
  automationStatusDistribution: Array<DistributionEntry<AutomationStatusBucket>>;
  /** The status the group as a whole sits at: the most-manual observed. */
  predominantAutomationStatus: AutomationStatusBucket;
  averageSameEdgeConfidence: number;
  minimumSameEdgeConfidence: number;
  averageSameEdgeSimilarity: number;
  occurrences: WorkflowOccurrence[];
}

function uniqueSorted(values: Array<string | null | undefined>): string[] {
  return [
    ...new Set(values.filter((v): v is string => typeof v === "string" && v.trim() !== "")),
  ].sort();
}

export function analyzeWorkflowGroup(group: RecurringIssueGroup, asOf: Date): AnalyzedWorkflow {
  const statuses = group.members.map((member) => toAutomationStatusBucket(member.automationStatus));

  const spanDays = group.firstSeen && group.lastSeen ? diffInDays(group.firstSeen, group.lastSeen) : null;

  const occurrences: WorkflowOccurrence[] = group.members.map((member) => ({
    rootTs: member.rootTs,
    postedAt: member.postedAt,
    permalink: member.permalink,
    // Fall back to the problem statement only if the workflow statement is
    // missing, so a group is never rendered with an empty body.
    normalizedWorkflowStatement:
      member.normalizedWorkflowStatement ?? member.normalizedProblemStatement ?? "",
    workflowClassification: member.workflowClassification ?? null,
    automationStatus: toAutomationStatusBucket(member.automationStatus),
    affectedSystem: member.affectedSystem ?? null,
  }));

  const predominantAutomationStatus =
    AUTOMATION_STATUS_ORDER.find((status) => statuses.includes(status)) ?? "unknown";

  return {
    groupId: group.groupId,
    name: group.name,
    alternateNames: group.alternateNames,
    occurrenceCount: group.occurrenceCount,
    consistency: group.consistency,
    needsReview: group.consistency !== "fully_confirmed",
    firstSeen: group.firstSeen,
    lastSeen: group.lastSeen,
    spanDays,
    averageDaysBetweenOccurrences:
      spanDays !== null && group.occurrenceCount > 1 ? spanDays / (group.occurrenceCount - 1) : null,
    daysSinceLastOccurrence: group.lastSeen ? diffInDays(group.lastSeen, asOf.toISOString()) : null,
    affectedSystems: uniqueSorted(group.members.map((member) => member.affectedSystem)),
    workflowClassifications: uniqueSorted(group.members.map((member) => member.workflowClassification)),
    automationStatusDistribution: distribute(statuses, AUTOMATION_STATUS_ORDER),
    predominantAutomationStatus,
    averageSameEdgeConfidence: group.averageSameEdgeConfidence,
    minimumSameEdgeConfidence: group.minimumSameEdgeConfidence,
    averageSameEdgeSimilarity: group.averageSameEdgeSimilarity,
    occurrences,
  };
}

/**
 * Tiered and lexicographic, matching the technical ranking's philosophy: no
 * invented weights. A workflow that is still fully manual outranks one already
 * partly automated at the same frequency, because that is where a tool pays off.
 */
export const WORKFLOW_RANKING_CRITERIA: readonly string[] = [
  "1. Occurrence count (how often a human is asked to do this by hand), descending",
  "2. Automation status: manual before partially_automated before already_automated before unknown",
  "3. Recency — days since the last request, ascending",
  "4. Group id, ascending (stable tie-break)",
];

const AUTOMATION_RANK: Record<AutomationStatusBucket, number> = {
  manual: 0,
  partially_automated: 1,
  already_automated: 2,
  unknown: 3,
};

export function rankWorkflows(workflows: AnalyzedWorkflow[]): AnalyzedWorkflow[] {
  return [...workflows].sort((a, b) => {
    if (a.occurrenceCount !== b.occurrenceCount) {
      return b.occurrenceCount - a.occurrenceCount;
    }
    const statusDelta =
      AUTOMATION_RANK[a.predominantAutomationStatus] - AUTOMATION_RANK[b.predominantAutomationStatus];
    if (statusDelta !== 0) {
      return statusDelta;
    }
    // A null recency sorts last rather than pretending to be recent.
    const aRecency = a.daysSinceLastOccurrence ?? Number.POSITIVE_INFINITY;
    const bRecency = b.daysSinceLastOccurrence ?? Number.POSITIVE_INFINITY;
    if (aRecency !== bRecency) {
      return aRecency - bRecency;
    }
    return a.groupId.localeCompare(b.groupId);
  });
}

export interface WorkflowReportSummary {
  recurringWorkflowCount: number;
  /** Unique manual requests across all recurring workflows. */
  totalOccurrences: number;
  fullyManualWorkflowCount: number;
  workflowsNeedingReview: number;
  largestWorkflowSize: number;
  automationStatusDistribution: Array<DistributionEntry<AutomationStatusBucket>>;
  earliestOccurrence: string | null;
  latestOccurrence: string | null;
}

export interface RecurringWorkflowReport {
  summary: WorkflowReportSummary;
  rankingCriteria: readonly string[];
  workflows: AnalyzedWorkflow[];
}

/**
 * Pure and deterministic, like the technical report — no API calls, no LLM.
 * Kept in its own model so workflow recurrence can never be added to defect
 * recurrence by accident.
 */
export function buildRecurringWorkflowReport(groupOutput: GroupOutput, asOf: Date): RecurringWorkflowReport {
  const workflows = rankWorkflows(groupOutput.groups.map((group) => analyzeWorkflowGroup(group, asOf)));

  const allOccurrences = workflows.flatMap((workflow) => workflow.occurrences);
  const dates = workflows
    .flatMap((workflow) => [workflow.firstSeen, workflow.lastSeen])
    .filter((value): value is string => value !== null)
    .sort();

  return {
    summary: {
      recurringWorkflowCount: workflows.length,
      totalOccurrences: allOccurrences.length,
      fullyManualWorkflowCount: workflows.filter((w) => w.predominantAutomationStatus === "manual").length,
      workflowsNeedingReview: workflows.filter((w) => w.needsReview).length,
      largestWorkflowSize: workflows.reduce((max, w) => Math.max(max, w.occurrenceCount), 0),
      automationStatusDistribution: distribute(
        allOccurrences.map((occurrence) => occurrence.automationStatus),
        AUTOMATION_STATUS_ORDER,
      ),
      earliestOccurrence: dates[0] ?? null,
      latestOccurrence: dates.at(-1) ?? null,
    },
    rankingCriteria: WORKFLOW_RANKING_CRITERIA,
    workflows,
  };
}
