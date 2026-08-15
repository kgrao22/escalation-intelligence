import {
  buildWorkflowRecommendationUserPrompt,
  WORKFLOW_RECOMMENDATION_PROMPT_VERSION,
  WORKFLOW_RECOMMENDATION_SYSTEM_PROMPT,
  type WorkflowRecommendationPayload,
} from "../llm/prompts/workflowRecommendation.js";
import { WorkflowRecommendationLLMOutputSchema } from "../llm/schemas/workflowRecommendation.js";
import { DEFAULT_RETRY_OPTIONS, withRetry, type RetryOptions } from "../llm/retry.js";
import type { StructuredParseFn } from "../llm/structuredParse.js";
import type { ExtractionOutput } from "../persistence/extractionOutput.js";
import type { WorkflowRecommendationItem } from "../persistence/workflowRecommendationOutput.js";
import type { ScoredWorkflowCluster } from "./workflowScoring.js";

export class WorkflowRecommendationParseError extends Error {
  constructor(clusterId: string, detail: string) {
    super(`Workflow recommendation for ${clusterId} did not match the expected schema: ${detail}`);
    this.name = "WorkflowRecommendationParseError";
  }
}

/** Statements beyond this are omitted; the representative already carries the shape. */
const MAX_MEMBER_STATEMENTS = 6;

export interface ClusterEvidence {
  statementsByRootTs: Map<string, string>;
  impactByRootTs: Map<string, string>;
}

export function buildClusterEvidence(extraction?: ExtractionOutput): ClusterEvidence {
  const statementsByRootTs = new Map<string, string>();
  const impactByRootTs = new Map<string, string>();
  for (const result of extraction?.results ?? []) {
    if (result.status !== "success" || !result.analysis) {
      continue;
    }
    const statement = result.analysis.normalizedWorkflowStatement;
    if (typeof statement === "string" && statement.trim() !== "") {
      statementsByRootTs.set(result.rootTs, statement);
    }
    impactByRootTs.set(result.rootTs, result.analysis.customerImpact);
  }
  return { statementsByRootTs, impactByRootTs };
}

/**
 * The EXACT payload that may cross the network, built by explicit field
 * projection. It carries no permalink, no rootTs, no raw Slack text — and no
 * baseScore or rank, so the model has no channel through which to influence
 * the deterministic ordering.
 */
export function buildRecommendationPayload(
  scored: ScoredWorkflowCluster,
  evidence: ClusterEvidence,
): WorkflowRecommendationPayload {
  const { cluster, scoringBreakdown } = scored;

  const memberStatements = cluster.memberRootTs
    .filter((rootTs) => rootTs !== cluster.representativeRootTs)
    .map((rootTs) => evidence.statementsByRootTs.get(rootTs))
    .filter((statement): statement is string => statement !== undefined)
    .filter((statement) => statement !== cluster.representativeWorkflowStatement)
    .slice(0, MAX_MEMBER_STATEMENTS);

  const customerImpactBreakdown: Record<string, number> = {};
  for (const rootTs of cluster.memberRootTs) {
    const impact = evidence.impactByRootTs.get(rootTs);
    if (impact !== undefined) {
      customerImpactBreakdown[impact] = (customerImpactBreakdown[impact] ?? 0) + 1;
    }
  }

  return {
    occurrenceCount: cluster.occurrenceCount,
    representativeWorkflowStatement: cluster.representativeWorkflowStatement,
    memberStatements,
    dominantWorkflowClassification: cluster.dominantWorkflowClassification,
    workflowClassifications: cluster.workflowClassifications,
    automationStatusBreakdown: cluster.automationStatusBreakdown,
    technicalWorkflowCount: cluster.technicalWorkflowCount,
    workflowOnlyCount: cluster.workflowOnlyCount,
    spanDays: scoringBreakdown.spanDays,
    daysSinceLastSeen: scoringBreakdown.daysSinceLastSeen,
    customerImpactBreakdown,
  };
}

export interface WorkflowRecommendationProgressEvent {
  index: number;
  total: number;
  clusterId: string;
  outcome: "success" | "failed";
  recommendedAction?: string;
  errorMessage?: string;
}

export interface RunWorkflowRecommendationParams {
  scored: ScoredWorkflowCluster[];
  evidence: ClusterEvidence;
  parseFn: StructuredParseFn<unknown>;
  model: string;
  onProgress?: (event: WorkflowRecommendationProgressEvent) => void;
  retryOptions?: RetryOptions;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Produces one recommendation per ranked cluster. Rank and baseScore are
 * assigned here from the deterministic ordering — never from the response —
 * and local metadata (permalinks, member rootTs) is reattached afterwards.
 * A failure on one cluster is recorded and the run continues.
 */
export async function runWorkflowRecommendation(
  params: RunWorkflowRecommendationParams,
): Promise<WorkflowRecommendationItem[]> {
  const items: WorkflowRecommendationItem[] = [];
  const total = params.scored.length;

  for (const [i, scored] of params.scored.entries()) {
    const index = i + 1;
    const { cluster } = scored;
    // Rank comes from the deterministic sort position, full stop.
    const base = {
      rank: index,
      clusterId: cluster.clusterId,
      occurrenceCount: cluster.occurrenceCount,
      representativeWorkflowStatement: cluster.representativeWorkflowStatement,
      baseScore: scored.baseScore,
      scoringBreakdown: scored.scoringBreakdown,
      dominantWorkflowClassification: cluster.dominantWorkflowClassification,
      automationStatusBreakdown: cluster.automationStatusBreakdown,
      firstSeen: cluster.firstSeen,
      lastSeen: cluster.lastSeen,
      // Local-only, reattached after the model has answered.
      memberRootTs: cluster.memberRootTs,
      samplePermalinks: cluster.samplePermalinks,
      relatedClusterIds: cluster.relatedClusterIds,
    };

    try {
      const userPrompt = buildWorkflowRecommendationUserPrompt(
        buildRecommendationPayload(scored, params.evidence),
      );
      const response = await withRetry(
        () =>
          params.parseFn({
            model: params.model,
            systemPrompt: WORKFLOW_RECOMMENDATION_SYSTEM_PROMPT,
            userPrompt,
          }),
        params.retryOptions ?? DEFAULT_RETRY_OPTIONS,
        params.sleep,
      );

      if (!response.parsed_output) {
        throw new WorkflowRecommendationParseError(
          cluster.clusterId,
          `stop_reason: ${response.stop_reason ?? "unknown"}`,
        );
      }

      const recommendation = WorkflowRecommendationLLMOutputSchema.parse(response.parsed_output);
      items.push({ ...base, status: "success", ...recommendation });
      params.onProgress?.({
        index,
        total,
        clusterId: cluster.clusterId,
        outcome: "success",
        recommendedAction: recommendation.recommendedAction,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      items.push({ ...base, status: "failed", error: errorMessage });
      params.onProgress?.({ index, total, clusterId: cluster.clusterId, outcome: "failed", errorMessage });
    }
  }

  return items;
}

export { WORKFLOW_RECOMMENDATION_PROMPT_VERSION };
