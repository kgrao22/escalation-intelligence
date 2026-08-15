import type { ExtractionOutput } from "../persistence/extractionOutput.js";
import type { ReportOutput } from "../persistence/reportOutput.js";
import type { WorkflowClusterOutput } from "../persistence/workflowClusterOutput.js";
import type { WorkflowRecommendationOutput } from "../persistence/workflowRecommendationOutput.js";
import { computeWorkflowBreakdown } from "../workflow/workflowStats.js";
import { deriveWorkflowTitle, workflowClassificationDisplayName } from "./displayNames.js";

export class ReviewIntegrityError extends Error {
  constructor(message: string) {
    super(`Review integrity check failed: ${message}`);
    this.name = "ReviewIntegrityError";
  }
}

/** Evidence links shown per item — enough to verify, not a dump. */
export const MAX_EVIDENCE_LINKS = 4;

/**
 * Leadership sees the strongest patterns, not every group. The full
 * recommendation artifacts remain the detailed source of truth.
 */
export const MAX_TECHNICAL_ISSUES_SHOWN = 8;

export interface ReviewOverview {
  windowTag: string;
  windowDays: number | null;
  threadsAnalysed: number;
  technicalEscalations: number;
  workflowCandidates: number;
  technicalAndWorkflow: number;
  workflowOnly: number;
  technicalOnly: number;
  neither: number;
  recurringWorkflowClusters: number;
  singletonWorkflows: number;
  /**
   * Threads that are technical, a workflow, or both — counted ONCE. Deliberately
   * not technical + workflow, which would double-count the overlap.
   */
  distinctActionableThreads: number;
  coverageFrom: string | null;
  coverageTo: string | null;
}

export interface ReviewAutomationOpportunity {
  rank: number;
  clusterId: string;
  title: string;
  /** Raw classification enum, so a renderer can tell generic labels apart. */
  classificationKey: string | null;
  /** The cluster's representative statement, for deriving a specific title. */
  representativeStatement: string;
  occurrenceCount: number;
  score: number;
  recommendedAction: string | null;
  priority: string | null;
  feasibility: string | null;
  patternSummary: string;
  proposedAutomation: string | null;
  guardrails: string[];
  expectedBenefit: string | null;
  evidenceLinks: string[];
}

export interface ReviewRecurringWorkflow {
  clusterId: string;
  title: string;
  classification: string;
  classificationKey: string | null;
  occurrenceCount: number;
  firstSeen: string | null;
  lastSeen: string | null;
  automationStatusBreakdown: Record<string, number>;
  workflowOnlyCount: number;
  technicalWorkflowCount: number;
  representativeStatement: string;
  evidenceLinks: string[];
}

export interface ReviewTechnicalSection {
  available: boolean;
  /** How many recurring issues exist in total, before the display cap. */
  totalRecurringIssues?: number;
  totalOccurrences?: number;
  totalOpenOccurrences?: number;
  /** Why it is absent, in words a reader outside the team can act on. */
  message: string;
  windowDays?: number;
  issues: Array<{
    name: string;
    occurrenceCount: number;
    openOccurrences: number;
    fullyResolved: boolean;
    peakSeverity: string;
    affectedSystems: string[];
    /** One-sentence remediation from the technical recommendations, if present. */
    remediation: string | null;
    evidenceLinks: string[];
  }>;
}

export interface ReviewLongTail {
  singletonWorkflowCount: number;
  topClassifications: Array<{ classification: string; label: string; count: number }>;
  note: string;
}

export interface ReviewNextAction {
  order: number;
  action: string;
  basis: string;
}

export interface ReviewData {
  overview: ReviewOverview;
  automationOpportunities: ReviewAutomationOpportunity[];
  recurringWorkflows: ReviewRecurringWorkflow[];
  technicalIssues: ReviewTechnicalSection;
  longTail: ReviewLongTail;
  nextActions: ReviewNextAction[];
}

export interface BuildReviewParams {
  windowTag: string;
  extraction: ExtractionOutput;
  clusters: WorkflowClusterOutput;
  recommendations: WorkflowRecommendationOutput;
  technicalReport?: ReportOutput;
  /** groupId → engineering recommendation, so the section says what to FIX. */
  technicalRemediation?: Map<string, string>;
}

function windowDaysFromTag(windowTag: string): number | null {
  const match = /^(\d+)d$/.exec(windowTag);
  return match ? Number.parseInt(match[1] as string, 10) : null;
}

/**
 * Every window must agree. A 90-day technical report presented inside a
 * 180-day review would misstate the period a reader is being asked to act on,
 * so a mismatch is rejected rather than footnoted.
 */
export function validateReviewInputs(params: BuildReviewParams): void {
  const expectedDays = windowDaysFromTag(params.windowTag);

  const declared: Array<[string, number | undefined]> = [
    ["extractions", params.extraction.metadata.sourceWindowDays],
    ["workflow clusters", params.clusters.metadata.sourceWindowDays],
    ["workflow recommendations", params.recommendations.metadata.sourceWindowDays],
  ];
  for (const [label, days] of declared) {
    if (expectedDays !== null && typeof days === "number" && days !== expectedDays) {
      throw new ReviewIntegrityError(
        `${label} covers ${days} days but the review window is ${params.windowTag}.`,
      );
    }
  }

  const clusterById = new Map(params.clusters.clusters.map((cluster) => [cluster.clusterId, cluster]));
  const ranks: number[] = [];

  for (const item of params.recommendations.recommendations) {
    const cluster = clusterById.get(item.clusterId);
    if (!cluster) {
      throw new ReviewIntegrityError(`recommendation references unknown cluster ${item.clusterId}.`);
    }
    if (cluster.occurrenceCount !== item.occurrenceCount) {
      throw new ReviewIntegrityError(
        `${item.clusterId} occurrence count disagrees: recommendations say ${item.occurrenceCount}, clusters say ${cluster.occurrenceCount}.`,
      );
    }
    const clusterLinks = new Set(cluster.samplePermalinks);
    const stray = item.samplePermalinks.filter((link) => !clusterLinks.has(link));
    if (stray.length > 0) {
      throw new ReviewIntegrityError(
        `${item.clusterId} carries evidence links not belonging to its cluster: ${stray[0] as string}`,
      );
    }
    ranks.push(item.rank);
  }

  const sortedRanks = [...ranks].sort((a, b) => a - b);
  if (new Set(ranks).size !== ranks.length) {
    throw new ReviewIntegrityError("recommendation ranks are not unique.");
  }
  for (const [index, rank] of sortedRanks.entries()) {
    if (rank !== index + 1) {
      throw new ReviewIntegrityError(`recommendation ranks are not contiguous from 1 (saw ${rank} at position ${index + 1}).`);
    }
  }

  if (params.technicalReport) {
    const technicalDays = params.technicalReport.metadata.sourceWindowDays;
    if (expectedDays !== null && technicalDays !== expectedDays) {
      throw new ReviewIntegrityError(
        `technical report covers ${technicalDays ?? "an unrecorded number of"} days but the review window is ${params.windowTag}. ` +
          "Run the technical pipeline for this window rather than presenting a shorter one as if it matched.",
      );
    }
  }
}

function limitLinks(links: string[]): string[] {
  return links.slice(0, MAX_EVIDENCE_LINKS);
}

/** First sentence of the representative statement, for a compact summary. */
function patternSummary(statement: string): string {
  const firstSentence = /^[^.]+\./.exec(statement)?.[0] ?? statement;
  return firstSentence.trim();
}

export function buildReview(params: BuildReviewParams): ReviewData {
  validateReviewInputs(params);

  const breakdown = computeWorkflowBreakdown(params.extraction.results);
  const clusterById = new Map(params.clusters.clusters.map((cluster) => [cluster.clusterId, cluster]));

  const recurringClusters = params.clusters.clusters
    .filter((cluster) => cluster.occurrenceCount >= 2)
    .sort((a, b) => b.occurrenceCount - a.occurrenceCount || a.clusterId.localeCompare(b.clusterId));
  const singletons = params.clusters.clusters.filter((cluster) => cluster.occurrenceCount < 2);

  const timestamps = params.clusters.clusters
    .flatMap((cluster) => [cluster.firstSeen, cluster.lastSeen])
    .filter((value): value is string => value !== null)
    .sort();

  const overview: ReviewOverview = {
    windowTag: params.windowTag,
    windowDays: windowDaysFromTag(params.windowTag),
    threadsAnalysed: breakdown.analysed,
    technicalEscalations: breakdown.technical,
    workflowCandidates: breakdown.workflowCandidates,
    technicalAndWorkflow: breakdown.technicalAndWorkflow,
    workflowOnly: breakdown.workflowOnly,
    technicalOnly: breakdown.technicalOnly,
    neither: breakdown.neither,
    recurringWorkflowClusters: recurringClusters.length,
    singletonWorkflows: singletons.length,
    // Union, not sum: the overlap is counted once.
    distinctActionableThreads:
      breakdown.technicalOnly + breakdown.workflowOnly + breakdown.technicalAndWorkflow,
    coverageFrom: timestamps[0] ?? null,
    coverageTo: timestamps.at(-1) ?? null,
  };

  // Rank and score come straight from the artifact — never recomputed here.
  const automationOpportunities: ReviewAutomationOpportunity[] = [...params.recommendations.recommendations]
    .sort((a, b) => a.rank - b.rank)
    .map((item) => {
      const cluster = clusterById.get(item.clusterId);
      return {
        rank: item.rank,
        clusterId: item.clusterId,
        title: deriveWorkflowTitle(item.dominantWorkflowClassification, item.representativeWorkflowStatement),
        classificationKey: item.dominantWorkflowClassification ?? null,
        representativeStatement: item.representativeWorkflowStatement,
        occurrenceCount: item.occurrenceCount,
        score: item.baseScore,
        recommendedAction: item.recommendedAction ?? null,
        priority: item.automationPriority ?? null,
        feasibility: item.automationFeasibility ?? null,
        patternSummary: patternSummary(item.representativeWorkflowStatement),
        proposedAutomation: item.proposedAutomation ?? null,
        guardrails: item.risksOrGuardrails ?? [],
        expectedBenefit: item.expectedBenefit ?? null,
        evidenceLinks: limitLinks(item.samplePermalinks.length > 0 ? item.samplePermalinks : cluster?.samplePermalinks ?? []),
      };
    });

  const recurringWorkflows: ReviewRecurringWorkflow[] = recurringClusters.map((cluster) => ({
    clusterId: cluster.clusterId,
    title: deriveWorkflowTitle(cluster.dominantWorkflowClassification, cluster.representativeWorkflowStatement),
    classification: workflowClassificationDisplayName(cluster.dominantWorkflowClassification),
    classificationKey: cluster.dominantWorkflowClassification ?? null,
    occurrenceCount: cluster.occurrenceCount,
    firstSeen: cluster.firstSeen,
    lastSeen: cluster.lastSeen,
    automationStatusBreakdown: cluster.automationStatusBreakdown,
    workflowOnlyCount: cluster.workflowOnlyCount,
    technicalWorkflowCount: cluster.technicalWorkflowCount,
    representativeStatement: cluster.representativeWorkflowStatement,
    evidenceLinks: limitLinks(cluster.samplePermalinks),
  }));

  const technicalIssues = buildTechnicalSection(params);

  const singletonCounts = singletons.reduce<Record<string, number>>((acc, cluster) => {
    const key = cluster.dominantWorkflowClassification ?? "(uncategorised)";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const longTail: ReviewLongTail = {
    singletonWorkflowCount: singletons.length,
    topClassifications: Object.entries(singletonCounts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([classification, count]) => ({
        classification,
        label: workflowClassificationDisplayName(classification),
        count,
      })),
    note:
      "These workflows were each requested once in the period. They are excluded from the automation ranking " +
      "and are worth monitoring rather than treating as automation candidates — a one-off request is not yet a pattern.",
  };

  return {
    overview,
    automationOpportunities,
    recurringWorkflows,
    technicalIssues,
    longTail,
    nextActions: buildNextActions(automationOpportunities, technicalIssues),
  };
}

function buildTechnicalSection(params: BuildReviewParams): ReviewTechnicalSection {
  if (!params.technicalReport) {
    return {
      available: false,
      message:
        `Technical recurrence analysis has not yet been generated for the full ${params.windowTag} window. ` +
        "The workflow intelligence below is complete; technical recurrence will be added after the matching " +
        `${params.windowTag} technical pipeline is run.`,
      issues: [],
    };
  }

  const report = params.technicalReport.report;
  return {
    available: true,
    message: `Recurring technical issues across the ${params.windowTag} window.`,
    windowDays: params.technicalReport.metadata.sourceWindowDays,
    totalRecurringIssues: report.issues.length,
    totalOccurrences: report.summary.totalOccurrences,
    totalOpenOccurrences: report.summary.totalOpenOccurrences,
    // Already ranked on evidence (occurrences, open count, severity, impact,
    // recency) — never on the model's own priority label, which marked 36 of
    // 44 issues "high" and so cannot discriminate.
    issues: report.issues.slice(0, MAX_TECHNICAL_ISSUES_SHOWN).map((issue) => ({
      name: issue.name ?? "(unnamed recurring issue)",
      occurrenceCount: issue.occurrenceCount,
      openOccurrences: issue.resolution.openCount,
      fullyResolved: issue.resolution.fullyResolved,
      peakSeverity: issue.peakSeverity,
      affectedSystems: issue.affectedSystems,
      remediation: params.technicalRemediation?.get(issue.groupId) ?? null,
      evidenceLinks: limitLinks(
        issue.occurrences
          .map((occurrence) => occurrence.permalink)
          .filter((link): link is string => link !== null),
      ),
    })),
  };
}

/**
 * Derived mechanically from the existing ranking — the action verb comes from
 * the recorded recommendedAction and the subject from the cluster's own title.
 * No LLM, and identical inputs always produce an identical list.
 */
export function buildNextActions(
  opportunities: ReviewAutomationOpportunity[],
  technical: ReviewTechnicalSection,
): ReviewNextAction[] {
  const VERBS: Record<string, string> = {
    internal_admin_tool: "Build an internal admin tool for",
    self_service_tooling: "Make self-service",
    process_automation: "Automate",
    permanent_code_fix: "Fix the underlying defect behind",
    monitoring_or_alerting: "Add monitoring for",
    documentation_or_training: "Document",
    keep_manual: "Keep manual and review",
    investigate_first: "Investigate",
  };

  const actions: ReviewNextAction[] = opportunities
    .filter((opportunity) => opportunity.recommendedAction !== null)
    .map((opportunity, index) => ({
      order: index + 1,
      action: `${VERBS[opportunity.recommendedAction as string] ?? "Address"} ${opportunity.title.toLowerCase()}`,
      basis: `${opportunity.occurrenceCount} occurrences, score ${opportunity.score.toFixed(2)}`,
    }));

  if (!technical.available) {
    actions.push({
      order: actions.length + 1,
      action: "Run the technical recurrence pipeline for this window to complete the picture",
      basis: "technical recurrence analysis is not yet available for this window",
    });
  }

  return actions;
}
