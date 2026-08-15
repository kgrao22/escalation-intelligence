import {
  buildWorkflowAdjudicationUserPrompt,
  WORKFLOW_ADJUDICATION_PROMPT_VERSION,
  WORKFLOW_ADJUDICATION_SYSTEM_PROMPT,
} from "../llm/prompts/workflowAdjudication.js";
import {
  enforceWorkflowNameInvariant,
  WorkflowAdjudicationLLMOutputSchema,
  type WorkflowAdjudicationLLMOutput,
} from "../llm/schemas/workflowAdjudication.js";
import { DEFAULT_RETRY_OPTIONS, withRetry, type RetryOptions } from "../llm/retry.js";
import type { StructuredParseFn } from "../llm/structuredParse.js";
import {
  lookupWorkflowAdjudication,
  type WorkflowAdjudicationResultItem,
} from "../persistence/workflowAdjudicationOutput.js";
import { toAdjudicationPayload, type WorkflowCandidatePair } from "./workflowCandidatePairs.js";

export class WorkflowAdjudicationParseError extends Error {
  constructor(pairId: string, detail: string) {
    super(`Workflow adjudication for pair ${pairId} did not match the expected schema: ${detail}`);
    this.name = "WorkflowAdjudicationParseError";
  }
}

export interface WorkflowAdjudicationProgressEvent {
  index: number;
  total: number;
  pairId: string;
  similarity: number;
  outcome: "success" | "failed" | "cached";
  relationship?: string;
  errorMessage?: string;
}

export interface RunWorkflowAdjudicationParams {
  candidates: WorkflowCandidatePair[];
  parseFn: StructuredParseFn<unknown>;
  model: string;
  promptVersion?: string;
  cache?: Map<string, WorkflowAdjudicationResultItem>;
  onProgress?: (event: WorkflowAdjudicationProgressEvent) => void;
  retryOptions?: RetryOptions;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Adjudicates one pair. Only the de-identified projection crosses the network:
 * `toAdjudicationPayload` selects fields explicitly, so rootTs, permalink, and
 * vectors cannot reach the prompt.
 */
export async function adjudicateWorkflowPair(
  parseFn: StructuredParseFn<unknown>,
  model: string,
  pair: WorkflowCandidatePair,
  retryOptions: RetryOptions = DEFAULT_RETRY_OPTIONS,
  sleep?: (ms: number) => Promise<void>,
): Promise<WorkflowAdjudicationLLMOutput> {
  const userPrompt = buildWorkflowAdjudicationUserPrompt(
    toAdjudicationPayload(pair.a),
    toAdjudicationPayload(pair.b),
    pair.similarity,
  );

  const response = await withRetry(
    () => parseFn({ model, systemPrompt: WORKFLOW_ADJUDICATION_SYSTEM_PROMPT, userPrompt }),
    retryOptions,
    sleep,
  );

  if (!response.parsed_output) {
    throw new WorkflowAdjudicationParseError(pair.pairId, `stop_reason: ${response.stop_reason ?? "unknown"}`);
  }

  try {
    return enforceWorkflowNameInvariant(WorkflowAdjudicationLLMOutputSchema.parse(response.parsed_output));
  } catch (err) {
    throw new WorkflowAdjudicationParseError(pair.pairId, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Runs the pool in order. A cached prior verdict is reused without an API call;
 * a failure on one pair is recorded and iteration continues, so a late failure
 * never discards earlier work.
 */
export async function runWorkflowAdjudication(
  params: RunWorkflowAdjudicationParams,
): Promise<WorkflowAdjudicationResultItem[]> {
  const promptVersion = params.promptVersion ?? WORKFLOW_ADJUDICATION_PROMPT_VERSION;
  const cache = params.cache ?? new Map<string, WorkflowAdjudicationResultItem>();
  const results: WorkflowAdjudicationResultItem[] = [];
  const total = params.candidates.length;

  for (const [i, pair] of params.candidates.entries()) {
    const index = i + 1;
    const cached = lookupWorkflowAdjudication(cache, pair.pairId, promptVersion, params.model);

    if (cached) {
      // Refresh local metadata from the current run; reuse only the verdict.
      results.push({ ...cached, similarity: pair.similarity, a: pair.a, b: pair.b });
      params.onProgress?.({
        index,
        total,
        pairId: pair.pairId,
        similarity: pair.similarity,
        outcome: "cached",
        relationship: cached.relationship,
      });
      continue;
    }

    try {
      const verdict = await adjudicateWorkflowPair(
        params.parseFn,
        params.model,
        pair,
        params.retryOptions,
        params.sleep,
      );
      results.push({
        pairId: pair.pairId,
        similarity: pair.similarity,
        a: pair.a,
        b: pair.b,
        sameClassification: pair.sameClassification,
        status: "success",
        relationship: verdict.relationship,
        confidence: verdict.confidence,
        reasoning: verdict.reasoning,
        proposedWorkflowName: verdict.proposedWorkflowName,
      });
      params.onProgress?.({
        index,
        total,
        pairId: pair.pairId,
        similarity: pair.similarity,
        outcome: "success",
        relationship: verdict.relationship,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      results.push({
        pairId: pair.pairId,
        similarity: pair.similarity,
        a: pair.a,
        b: pair.b,
        sameClassification: pair.sameClassification,
        status: "failed",
        error: errorMessage,
      });
      params.onProgress?.({
        index,
        total,
        pairId: pair.pairId,
        similarity: pair.similarity,
        outcome: "failed",
        errorMessage,
      });
    }
  }

  return results;
}
