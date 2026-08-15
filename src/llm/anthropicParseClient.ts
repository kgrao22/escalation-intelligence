import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { EscalationParseFn } from "./extractEscalation.js";
import { EscalationAnalysisLLMOutputSchema } from "./schemas/escalationAnalysis.js";
import { createStructuredParseFn, withEnumNormalization } from "./structuredParse.js";

/**
 * Generous enough for every schema field (a handful of short strings/enums)
 * without approaching the ~16K non-streaming timeout threshold — this is a
 * classification/extraction task, not open-ended generation.
 */
const MAX_OUTPUT_TOKENS = 1536;

/**
 * Strict Zod validation, with invalid enum values normalized onto the v3.1
 * prompt's documented fallbacks first. The wire schema is unchanged, so the
 * model is still constrained to the real enum vocabulary.
 */
const OUTPUT_FORMAT = withEnumNormalization(zodOutputFormat(EscalationAnalysisLLMOutputSchema));

export function createAnthropicParseFn(client: Anthropic): EscalationParseFn {
  return createStructuredParseFn(client, OUTPUT_FORMAT, MAX_OUTPUT_TOKENS);
}
