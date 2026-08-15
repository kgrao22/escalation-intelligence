import {
  buildIssueRecommendationUserPrompt,
  ISSUE_RECOMMENDATION_SYSTEM_PROMPT,
} from "../llm/prompts/issueRecommendation.js";
import { DEFAULT_RETRY_OPTIONS, withRetry, type RetryOptions } from "../llm/retry.js";
import {
  enforceAutomationIdeaInvariant,
  type IssueRecommendationLLMOutput,
} from "../llm/schemas/issueRecommendation.js";
import type { StructuredParseFn } from "../llm/structuredParse.js";
import type { RankedGroup } from "../report/rankGroups.js";
import { buildRecommendationPayload } from "./buildPayload.js";

export type RecommendationParseFn = StructuredParseFn<IssueRecommendationLLMOutput>;

export class RecommendationRefusedError extends Error {
  constructor(groupId: string) {
    super(`LLM declined to recommend an action for ${groupId} (stop_reason: refusal)`);
    this.name = "RecommendationRefusedError";
  }
}

export class RecommendationParseError extends Error {
  constructor(groupId: string, stopReason: string | null) {
    super(
      `LLM response for ${groupId} did not match the expected schema (stop_reason: ${stopReason ?? "unknown"})`,
    );
    this.name = "RecommendationParseError";
  }
}

export interface IssueRecommendation extends IssueRecommendationLLMOutput {
  groupId: string;
  redactionCount: number;
}

export async function recommendIssue(
  parseFn: RecommendationParseFn,
  model: string,
  issue: RankedGroup,
  retryOptions: RetryOptions = DEFAULT_RETRY_OPTIONS,
  sleep?: (ms: number) => Promise<void>,
): Promise<IssueRecommendation> {
  const payload = buildRecommendationPayload(issue);

  const response = await withRetry(
    () =>
      parseFn({
        model,
        systemPrompt: ISSUE_RECOMMENDATION_SYSTEM_PROMPT,
        userPrompt: buildIssueRecommendationUserPrompt(payload),
      }),
    retryOptions,
    sleep,
  );

  if (response.stop_reason === "refusal") {
    throw new RecommendationRefusedError(issue.groupId);
  }
  if (!response.parsed_output) {
    throw new RecommendationParseError(issue.groupId, response.stop_reason);
  }

  return {
    ...enforceAutomationIdeaInvariant(response.parsed_output),
    groupId: issue.groupId,
    redactionCount: payload.redactionCount,
  };
}
