import type { ExtractionOutput } from "../persistence/extractionOutput.js";
import type { WorkflowCluster } from "./buildWorkflowClusters.js";

/** Clusters below this never enter the automation ranking. */
export const MIN_OCCURRENCES_FOR_RANKING = 2;

/**
 * Weights sum to 100. They are round numbers chosen to express an ordering of
 * concerns — how often the work recurs matters most, how manual it is next —
 * rather than tuned against this dataset. Deliberately coarse: precise weights
 * would imply a precision the underlying signals do not have.
 */
export const SCORING_WEIGHTS = {
  frequency: 30,
  manualBurden: 25,
  automationReadiness: 15,
  engineeringDependency: 10,
  customerImpact: 10,
  recency: 10,
} as const;

export type ScoringFactor = keyof typeof SCORING_WEIGHTS;

/**
 * Occurrences at which the frequency sub-score approaches its ceiling. Set
 * above the largest observed cluster so the curve never flattens across the
 * real data, and so the scale does not shift when a bigger cluster appears.
 */
const FREQUENCY_SATURATION = 24;

/** Days within which a workflow counts as fully current. */
const RECENCY_FRESH_DAYS = 14;
/** Days beyond which recency contributes nothing. */
const RECENCY_STALE_DAYS = 180;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** How much human effort each automation status implies. */
const MANUAL_BURDEN_BY_STATUS: Record<string, number> = {
  manual: 100,
  partially_automated: 60,
  unknown: 50,
  already_automated: 10,
};

/**
 * How amenable each workflow shape is to guarded tooling. Bounded state
 * transitions and field propagation score high; open-ended repair work scores
 * low because it resists a fixed interface.
 */
const READINESS_BY_CLASSIFICATION: Record<string, number> = {
  policy_state_change: 85,
  policy_cancellation: 85,
  policy_reactivation: 85,
  customer_identity_update: 80,
  account_data_update: 75,
  access_or_permission_change: 75,
  manual_document_operation: 65,
  manual_reconciliation: 50,
  manual_backend_correction: 45,
  other_operational_workflow: 40,
};
const DEFAULT_READINESS = 50;

/** Workflows needing privileged backend access rather than an admin screen. */
const PRIVILEGED_CLASSIFICATIONS = new Set([
  "manual_backend_correction",
  "manual_reconciliation",
  "access_or_permission_change",
]);

const IMPACT_SCORES: Record<string, number> = {
  multiple_customers: 100,
  single_customer: 60,
  unknown: 40,
  none: 20,
};
const NEUTRAL_IMPACT = 50;

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Saturating log curve: real separation at low counts, no runaway at high ones. */
export function frequencyScore(occurrenceCount: number): number {
  if (occurrenceCount <= 0) {
    return 0;
  }
  return clamp((Math.log(1 + occurrenceCount) / Math.log(1 + FREQUENCY_SATURATION)) * 100);
}

export function manualBurdenScore(breakdown: Record<string, number>): number {
  const entries = Object.entries(breakdown);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) {
    return NEUTRAL_IMPACT;
  }
  const weighted = entries.reduce(
    (sum, [status, count]) => sum + (MANUAL_BURDEN_BY_STATUS[status] ?? NEUTRAL_IMPACT) * count,
    0,
  );
  return clamp(weighted / total);
}

/**
 * A cluster spanning many classifications is a less bounded target, so each
 * additional shape past the first costs a little readiness.
 */
export function automationReadinessScore(cluster: WorkflowCluster): number {
  const classifications =
    cluster.workflowClassifications.length > 0 ? cluster.workflowClassifications : ["other_operational_workflow"];
  const base =
    classifications.reduce((sum, name) => sum + (READINESS_BY_CLASSIFICATION[name] ?? DEFAULT_READINESS), 0) /
    classifications.length;
  const coherencePenalty = 8 * (classifications.length - 1);
  return clamp(base - coherencePenalty);
}

/**
 * Every one of these reached the engineering escalation channel, so support
 * could not self-serve it — that is the 50-point baseline. Code-level
 * involvement and privileged access raise it from there.
 */
export function engineeringDependencyScore(cluster: WorkflowCluster): number {
  const total = cluster.occurrenceCount || 1;
  const technicalShare = cluster.technicalWorkflowCount / total;
  const privilegedShare =
    cluster.workflowClassifications.length === 0
      ? 0
      : cluster.workflowClassifications.filter((name) => PRIVILEGED_CLASSIFICATIONS.has(name)).length /
        cluster.workflowClassifications.length;
  return clamp(50 + 30 * technicalShare + 20 * privilegedShare);
}

export function recencyScore(lastSeen: string | null, asOf: Date): number {
  if (!lastSeen) {
    return 0;
  }
  const last = Date.parse(lastSeen);
  if (Number.isNaN(last)) {
    return 0;
  }
  const days = (asOf.getTime() - last) / MS_PER_DAY;
  if (days <= RECENCY_FRESH_DAYS) {
    return 100;
  }
  if (days >= RECENCY_STALE_DAYS) {
    return 0;
  }
  return clamp(100 * (1 - (days - RECENCY_FRESH_DAYS) / (RECENCY_STALE_DAYS - RECENCY_FRESH_DAYS)));
}

/**
 * Impact comes from the extraction records for this cluster's members and
 * nothing else. With no extraction data the factor is explicitly neutral —
 * never inferred from the workflow text.
 */
export function customerImpactScore(
  cluster: WorkflowCluster,
  impactByRootTs: Map<string, string>,
): { score: number; evidenceCount: number } {
  const impacts = cluster.memberRootTs
    .map((rootTs) => impactByRootTs.get(rootTs))
    .filter((value): value is string => value !== undefined);

  if (impacts.length === 0) {
    return { score: NEUTRAL_IMPACT, evidenceCount: 0 };
  }
  const total = impacts.reduce((sum, impact) => sum + (IMPACT_SCORES[impact] ?? NEUTRAL_IMPACT), 0);
  return { score: clamp(total / impacts.length), evidenceCount: impacts.length };
}

export function buildCustomerImpactIndex(extraction?: ExtractionOutput): Map<string, string> {
  const index = new Map<string, string>();
  for (const result of extraction?.results ?? []) {
    if (result.status === "success" && result.analysis) {
      index.set(result.rootTs, result.analysis.customerImpact);
    }
  }
  return index;
}

export interface ScoringBreakdown {
  factors: Record<ScoringFactor, { raw: number; weight: number; weighted: number }>;
  /** Restates the formula in the artifact so a score is auditable in isolation. */
  formula: string;
  customerImpactEvidenceCount: number;
  daysSinceLastSeen: number | null;
  spanDays: number | null;
}

export interface ScoredWorkflowCluster {
  cluster: WorkflowCluster;
  baseScore: number;
  scoringBreakdown: ScoringBreakdown;
}

export const SCORING_FORMULA =
  "baseScore = 0.30*frequency + 0.25*manualBurden + 0.15*automationReadiness + " +
  "0.10*engineeringDependency + 0.10*customerImpact + 0.10*recency (each factor 0-100)";

export function scoreCluster(
  cluster: WorkflowCluster,
  impactByRootTs: Map<string, string>,
  asOf: Date,
): ScoredWorkflowCluster {
  const impact = customerImpactScore(cluster, impactByRootTs);
  const raw: Record<ScoringFactor, number> = {
    frequency: frequencyScore(cluster.occurrenceCount),
    manualBurden: manualBurdenScore(cluster.automationStatusBreakdown),
    automationReadiness: automationReadinessScore(cluster),
    engineeringDependency: engineeringDependencyScore(cluster),
    customerImpact: impact.score,
    recency: recencyScore(cluster.lastSeen, asOf),
  };

  const factors = {} as ScoringBreakdown["factors"];
  let baseScore = 0;
  for (const [name, weight] of Object.entries(SCORING_WEIGHTS) as Array<[ScoringFactor, number]>) {
    const weighted = (raw[name] * weight) / 100;
    factors[name] = { raw: round(raw[name]), weight, weighted: round(weighted) };
    baseScore += weighted;
  }

  const days = (from: string | null, to: string | null): number | null => {
    if (!from || !to) {
      return null;
    }
    const start = Date.parse(from);
    const end = Date.parse(to);
    return Number.isNaN(start) || Number.isNaN(end) ? null : Math.round((end - start) / MS_PER_DAY);
  };

  return {
    cluster,
    baseScore: round(clamp(baseScore)),
    scoringBreakdown: {
      factors,
      formula: SCORING_FORMULA,
      customerImpactEvidenceCount: impact.evidenceCount,
      daysSinceLastSeen: days(cluster.lastSeen, asOf.toISOString()),
      spanDays: days(cluster.firstSeen, cluster.lastSeen),
    },
  };
}

/** Recurring clusters only; singletons are reported separately as a long tail. */
export function selectRankableClusters(clusters: WorkflowCluster[]): WorkflowCluster[] {
  return clusters.filter((cluster) => cluster.occurrenceCount >= MIN_OCCURRENCES_FOR_RANKING);
}

/**
 * Ranks by deterministic score alone. Ties break on occurrence count then
 * cluster id, so ordering is reproducible and never depends on LLM output.
 */
export function rankClusters(
  clusters: WorkflowCluster[],
  impactByRootTs: Map<string, string>,
  asOf: Date,
): ScoredWorkflowCluster[] {
  return selectRankableClusters(clusters)
    .map((cluster) => scoreCluster(cluster, impactByRootTs, asOf))
    .sort(
      (a, b) =>
        b.baseScore - a.baseScore ||
        b.cluster.occurrenceCount - a.cluster.occurrenceCount ||
        a.cluster.clusterId.localeCompare(b.cluster.clusterId),
    );
}
