import type Anthropic from "@anthropic-ai/sdk";
import {
  normalizeEnumValues,
  recordNormalizationDiagnostics,
  type EnumNormalizationDiagnostic,
} from "./enumNormalization.js";

export interface StructuredParseRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
}

export interface StructuredParseResponse<T> {
  parsed_output: T | null;
  stop_reason: string | null;
}

/**
 * Decoupled from the SDK so business logic only needs "given a request, get a
 * parsed response back" — trivial to fake in tests and impossible to reach
 * the network from one.
 */
export type StructuredParseFn<T> = (request: StructuredParseRequest) => Promise<StructuredParseResponse<T>>;

/**
 * Structural shape of what `zodOutputFormat()` returns. Declared here rather
 * than imported from the SDK's internal `lib/parser` module, which is not a
 * supported entry point.
 */
export interface ParseableOutputFormat<T> {
  type: "json_schema";
  schema: { [key: string]: unknown };
  parse(content: string): T;
}

/**
 * Wraps an output format so invalid enum values are rewritten onto documented
 * fallbacks BEFORE strict validation runs. Three properties matter:
 *
 * 1. `schema` is passed through untouched, so the JSON Schema sent to the API
 *    keeps its exact enum constraints — the model is still grammar-constrained
 *    to the real vocabulary, and this wrapper only handles what slips past.
 * 2. Validation stays strict: normalization can only produce values the schema
 *    already accepts, and anything else still fails loudly.
 * 3. A response with no invalid enums is passed to the schema unmodified.
 *
 * The SDK's parser calls `outputFormat.parse(rawText)` on the assistant's text
 * (see `lib/parser.js`), which is the seam this hooks into.
 */
export function withEnumNormalization<T>(outputFormat: ParseableOutputFormat<T>): ParseableOutputFormat<T> {
  return {
    type: outputFormat.type,
    schema: outputFormat.schema,
    parse(content: string): T {
      const { value, diagnostics } = normalizeEnumValues(JSON.parse(content) as unknown);
      // Re-serialise so the underlying format performs its own strict parse
      // exactly as it would have on an untouched response.
      const parsed = outputFormat.parse(diagnostics.length === 0 ? content : JSON.stringify(value));
      recordNormalizationDiagnostics(parsed, diagnostics);
      return parsed;
    },
  };
}

export type { EnumNormalizationDiagnostic };

/**
 * Shared wiring for every schema-constrained call in the pipeline. The Zod
 * schema is compiled to JSON Schema and enforced by the API, so a response
 * either matches the shape or `parsed_output` is null — callers never have to
 * guess at a malformed object.
 */
export function createStructuredParseFn<T>(
  client: Anthropic,
  outputFormat: ParseableOutputFormat<T>,
  maxTokens: number,
): StructuredParseFn<T> {
  return async ({ model, systemPrompt, userPrompt }) => {
    const response = await client.messages.parse({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      output_config: { format: outputFormat },
    });

    return {
      parsed_output: (response.parsed_output ?? null) as T | null,
      stop_reason: response.stop_reason,
    };
  };
}
