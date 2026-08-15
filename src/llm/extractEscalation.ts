import type { EscalationThread } from "../slack/escalationThreads.js";
import {
  readNormalizationDiagnostics,
  recordNormalizationDiagnostics,
} from "./enumNormalization.js";
import { preprocessThreadForLLM } from "./preprocessThread.js";
import { buildEscalationExtractionUserPrompt, ESCALATION_EXTRACTION_SYSTEM_PROMPT } from "./prompts/escalationExtraction.js";
import { DEFAULT_RETRY_OPTIONS, withRetry, type RetryOptions } from "./retry.js";
import {
  enforceAnalysisInvariants,
  type EscalationAnalysis,
  type EscalationAnalysisLLMOutput,
} from "./schemas/escalationAnalysis.js";

export class ExtractionRefusedError extends Error {
  constructor(rootTs: string) {
    super(`LLM declined to analyse thread ${rootTs} (stop_reason: refusal)`);
    this.name = "ExtractionRefusedError";
  }
}

export class ExtractionParseError extends Error {
  constructor(rootTs: string, stopReason: string | null) {
    super(`LLM response for thread ${rootTs} did not match the expected schema (stop_reason: ${stopReason ?? "unknown"})`);
    this.name = "ExtractionParseError";
  }
}

export interface EscalationExtractionRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
}

export interface EscalationParseResponse {
  parsed_output: EscalationAnalysisLLMOutput | null;
  stop_reason: string | null;
}

/**
 * Decoupled from the Anthropic SDK on purpose: business logic here only
 * needs "given a request, get a parsed response back," which makes it
 * trivial to test with a fake function and impossible to accidentally hit
 * a real API from a unit test. The real implementation lives in
 * anthropicParseClient.ts.
 */
export type EscalationParseFn = (request: EscalationExtractionRequest) => Promise<EscalationParseResponse>;

export async function extractEscalationAnalysis(
  parseFn: EscalationParseFn,
  model: string,
  thread: EscalationThread,
  retryOptions: RetryOptions = DEFAULT_RETRY_OPTIONS,
  sleep?: (ms: number) => Promise<void>,
): Promise<EscalationAnalysis> {
  const cleaned = preprocessThreadForLLM(thread);
  const userPrompt = buildEscalationExtractionUserPrompt(cleaned.combinedText);

  const response = await withRetry(
    () => parseFn({ model, systemPrompt: ESCALATION_EXTRACTION_SYSTEM_PROMPT, userPrompt }),
    retryOptions,
    sleep,
  );

  if (response.stop_reason === "refusal") {
    throw new ExtractionRefusedError(thread.rootTs);
  }
  if (!response.parsed_output) {
    throw new ExtractionParseError(thread.rootTs, response.stop_reason);
  }

  // Diagnostics are keyed on the object the parser produced, so they must be
  // read before the invariants build a new one, then re-attached to it.
  const diagnostics = readNormalizationDiagnostics(response.parsed_output);
  const analysis: EscalationAnalysis = {
    ...enforceAnalysisInvariants(response.parsed_output),
    rootTs: thread.rootTs,
    permalink: thread.permalink ?? null,
  };
  recordNormalizationDiagnostics(analysis, diagnostics);
  return analysis;
}
