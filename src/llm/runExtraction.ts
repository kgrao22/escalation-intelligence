import type { EscalationThread } from "../slack/escalationThreads.js";
import { pickLatestDatedFilename } from "../persistence/datedFiles.js";
import type { ExtractionResultItem, ExtractionRunMetadata } from "../persistence/extractionOutput.js";
import { lookupPriorResult } from "../persistence/extractionOutput.js";
import { readNormalizationDiagnostics } from "./enumNormalization.js";
import { extractEscalationAnalysis, type EscalationParseFn } from "./extractEscalation.js";
import { preprocessThreadForLLM } from "./preprocessThread.js";
import type { RetryOptions } from "./retry.js";
import type { EnumNormalizationDiagnostic } from "./enumNormalization.js";
import { computeWorkflowBreakdown, countWorkflowClassifications } from "../workflow/workflowStats.js";

/** Picks the newest `escalations-YYYY-MM-DD.json` filename. */
export function pickLatestFetchFilename(filenames: string[]): string | null {
  return pickLatestDatedFilename(filenames, "escalations");
}

export function computeExtractionTargets(threads: EscalationThread[], limit?: number): EscalationThread[] {
  return limit === undefined ? threads : threads.slice(0, limit);
}

export interface DryRunStats {
  threadCount: number;
  totalCombinedChars: number;
  averageCharsPerThread: number;
  /** Rough ~4-chars-per-token heuristic, not a real tokenizer count — just enough to sanity-check payload size before spending real API calls. */
  approxTotalInputTokens: number;
}

export function estimateDryRunStats(threads: EscalationThread[]): DryRunStats {
  const charCounts = threads.map((thread) => preprocessThreadForLLM(thread).combinedText.length);
  const totalCombinedChars = charCounts.reduce((sum, count) => sum + count, 0);
  const threadCount = threads.length;

  return {
    threadCount,
    totalCombinedChars,
    averageCharsPerThread: threadCount > 0 ? Math.round(totalCombinedChars / threadCount) : 0,
    approxTotalInputTokens: Math.round(totalCombinedChars / 4),
  };
}

export interface ProgressEvent {
  index: number;
  total: number;
  rootTs: string;
  outcome: "success" | "failed" | "cached";
  classification?: string;
  isTechnicalEscalation?: boolean;
  errorMessage?: string;
  /** Non-empty when an invalid enum value was rewritten onto a fallback. */
  normalizations?: EnumNormalizationDiagnostic[];
}

export interface AnalyzeThreadsParams {
  threads: EscalationThread[];
  parseFn: EscalationParseFn;
  model: string;
  promptVersion: string;
  priorResultsIndex: Map<string, ExtractionResultItem>;
  onProgress?: (event: ProgressEvent) => void;
  retryOptions?: RetryOptions;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Analyses each thread in order. A cached prior success is reused without
 * calling the LLM again (resumability/cost safety). A failure on one thread
 * is recorded and iteration continues — previously completed results in
 * this same run are never lost because of a later failure.
 */
export async function analyzeThreads(params: AnalyzeThreadsParams): Promise<ExtractionResultItem[]> {
  const results: ExtractionResultItem[] = [];
  const total = params.threads.length;

  for (const [i, thread] of params.threads.entries()) {
    const index = i + 1;
    const cached = lookupPriorResult(params.priorResultsIndex, thread.rootTs, params.promptVersion, params.model);

    if (cached?.analysis) {
      results.push(cached);
      params.onProgress?.({
        index,
        total,
        rootTs: thread.rootTs,
        outcome: "cached",
        classification: cached.analysis.classification,
        isTechnicalEscalation: cached.analysis.isTechnicalEscalation,
      });
      continue;
    }

    try {
      const analysis = await extractEscalationAnalysis(
        params.parseFn,
        params.model,
        thread,
        params.retryOptions,
        params.sleep,
      );
      const normalizations = readNormalizationDiagnostics(analysis);
      results.push({
        rootTs: thread.rootTs,
        status: "success",
        analysis,
        ...(normalizations.length > 0 ? { normalizations } : {}),
      });
      params.onProgress?.({
        index,
        total,
        rootTs: thread.rootTs,
        outcome: "success",
        classification: analysis.classification,
        isTechnicalEscalation: analysis.isTechnicalEscalation,
        ...(normalizations.length > 0 ? { normalizations } : {}),
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      results.push({ rootTs: thread.rootTs, status: "failed", error: errorMessage });
      params.onProgress?.({ index, total, rootTs: thread.rootTs, outcome: "failed", errorMessage });
    }
  }

  return results;
}

export function buildExtractionMetadata(params: {
  inputFile: string;
  analysedAt: Date;
  promptVersion: string;
  promptRevision?: string;
  model: string;
  threadsAvailable: number;
  results: ExtractionResultItem[];
}): ExtractionRunMetadata {
  const breakdown = computeWorkflowBreakdown(params.results);

  return {
    inputFile: params.inputFile,
    analysedAt: params.analysedAt.toISOString(),
    promptVersion: params.promptVersion,
    ...(params.promptRevision ? { promptRevision: params.promptRevision } : {}),
    model: params.model,
    threadsAvailable: params.threadsAvailable,
    threadsAnalysed: params.results.length,
    technicalEscalations: breakdown.technical,
    nonTechnical: breakdown.nonTechnical,
    failedExtractions: breakdown.failed,
    workflowCandidates: breakdown.workflowCandidates,
    nonWorkflow: breakdown.nonWorkflow,
    technicalAndWorkflow: breakdown.technicalAndWorkflow,
    workflowOnly: breakdown.workflowOnly,
    technicalOnly: breakdown.technicalOnly,
    neither: breakdown.neither,
    workflowClassificationCounts: countWorkflowClassifications(params.results),
  };
}

/**
 * Replaces prior results with repaired ones by rootTs, preserving the original
 * ordering and never appending a duplicate. Results not present in `repaired`
 * are returned untouched — this is what keeps 293 successes free on a retry.
 */
export function mergeRepairedResults(
  prior: ExtractionResultItem[],
  repaired: ExtractionResultItem[],
): ExtractionResultItem[] {
  const byRootTs = new Map(repaired.map((result) => [result.rootTs, result]));
  return prior.map((result) => byRootTs.get(result.rootTs) ?? result);
}

/** The rootTs values whose prior extraction failed — exactly what a retry targets. */
export function failedRootTsValues(results: ExtractionResultItem[]): string[] {
  return results.filter((result) => result.status === "failed").map((result) => result.rootTs);
}
