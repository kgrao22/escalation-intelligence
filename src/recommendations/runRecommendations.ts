import type { RetryOptions } from "../llm/retry.js";
import type { RecommendationResultItem } from "../persistence/recommendationOutput.js";
import { lookupPriorRecommendation } from "../persistence/recommendationOutput.js";
import type { RankedGroup } from "../report/rankGroups.js";
import { recommendIssue, type RecommendationParseFn } from "./recommendIssue.js";

export function limitIssues(issues: RankedGroup[], limit?: number): RankedGroup[] {
  return limit === undefined ? issues : issues.slice(0, limit);
}

export interface RecommendationProgressEvent {
  index: number;
  total: number;
  groupId: string;
  name: string | null;
  outcome: "success" | "failed" | "cached";
  recommendedAction?: string;
  priority?: string;
  errorMessage?: string;
}

export interface RunRecommendationsParams {
  issues: RankedGroup[];
  parseFn: RecommendationParseFn;
  model: string;
  promptVersion: string;
  priorIndex: Map<string, RecommendationResultItem>;
  onProgress?: (event: RecommendationProgressEvent) => void;
  retryOptions?: RetryOptions;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunRecommendationsResult {
  results: RecommendationResultItem[];
  redactionsApplied: number;
}

function permalinksFor(issue: RankedGroup): RecommendationResultItem["permalinks"] {
  return issue.occurrences.map((occurrence) => ({
    rootTs: occurrence.rootTs,
    permalink: occurrence.permalink,
  }));
}

/**
 * One Claude call per recurring issue, in rank order.
 *
 * Issues are deliberately not batched into a single prompt: independent calls
 * keep each recommendation uninfluenced by its neighbours, make retries and
 * resumability per-issue, and stop one bad response from discarding the rest
 * of the run.
 */
export async function runRecommendations(
  params: RunRecommendationsParams,
): Promise<RunRecommendationsResult> {
  const results: RecommendationResultItem[] = [];
  const total = params.issues.length;
  let redactionsApplied = 0;

  for (const [i, issue] of params.issues.entries()) {
    const index = i + 1;
    const cached = lookupPriorRecommendation(params.priorIndex, issue.groupId, params.promptVersion, params.model);

    if (cached) {
      results.push(cached);
      params.onProgress?.({
        index,
        total,
        groupId: issue.groupId,
        name: issue.name,
        outcome: "cached",
        recommendedAction: cached.recommendedAction,
        priority: cached.priority,
      });
      continue;
    }

    try {
      const recommendation = await recommendIssue(
        params.parseFn,
        params.model,
        issue,
        params.retryOptions,
        params.sleep,
      );
      redactionsApplied += recommendation.redactionCount;

      results.push({
        groupId: issue.groupId,
        name: issue.name,
        occurrenceCount: issue.occurrenceCount,
        permalinks: permalinksFor(issue),
        status: "success",
        recommendedAction: recommendation.recommendedAction,
        priority: recommendation.priority,
        engineeringRecommendation: recommendation.engineeringRecommendation,
        rationale: recommendation.rationale,
        evidenceSummary: recommendation.evidenceSummary,
        automationOpportunity: recommendation.automationOpportunity,
        automationIdea: recommendation.automationIdea,
        confidence: recommendation.confidence,
      });

      params.onProgress?.({
        index,
        total,
        groupId: issue.groupId,
        name: issue.name,
        outcome: "success",
        recommendedAction: recommendation.recommendedAction,
        priority: recommendation.priority,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      results.push({
        groupId: issue.groupId,
        name: issue.name,
        occurrenceCount: issue.occurrenceCount,
        permalinks: permalinksFor(issue),
        status: "failed",
        error: errorMessage,
      });
      params.onProgress?.({
        index,
        total,
        groupId: issue.groupId,
        name: issue.name,
        outcome: "failed",
        errorMessage,
      });
    }
  }

  return { results, redactionsApplied };
}
