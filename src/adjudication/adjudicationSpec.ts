import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { PipelineCategory } from "../categories.js";
import {
  buildRecurrenceAdjudicationUserPrompt,
  RECURRENCE_ADJUDICATION_PROMPT_VERSION,
  RECURRENCE_ADJUDICATION_SYSTEM_PROMPT,
} from "../llm/prompts/recurrenceAdjudication.js";
import {
  enforceIssueNameInvariant,
  RecurrenceAdjudicationLLMOutputSchema,
} from "../llm/schemas/recurrenceAdjudication.js";
import type { AnyRelationship } from "../llm/schemas/workflowAdjudication.js";
import { RELATIONSHIPS } from "../llm/schemas/recurrenceAdjudication.js";
import type { ParseableOutputFormat } from "../llm/structuredParse.js";
import type { CandidatePairSide } from "./candidatePairs.js";

/**
 * Both tracks reduce to the same shape once invariants are applied, so
 * grouping, naming, and reporting need only one implementation. The
 * vocabulary differs; the structure does not.
 */
export interface NormalizedAdjudication {
  relationship: AnyRelationship;
  confidence: number;
  reasoning: string;
  /** The recurring group name, when the verdict warrants one. */
  proposedName: string | null;
}

export interface AdjudicationSpec {
  category: PipelineCategory;
  promptVersion: string;
  systemPrompt: string;
  outputFormat: ParseableOutputFormat<unknown>;
  /** The verdict vocabulary for this track, for reporting and tallies. */
  relationships: readonly AnyRelationship[];
  buildUserPrompt(a: CandidatePairSide, b: CandidatePairSide): string;
  normalize(raw: unknown): NormalizedAdjudication;
}

const TECHNICAL_SPEC: AdjudicationSpec = {
  category: "technical",
  promptVersion: RECURRENCE_ADJUDICATION_PROMPT_VERSION,
  systemPrompt: RECURRENCE_ADJUDICATION_SYSTEM_PROMPT,
  outputFormat: zodOutputFormat(RecurrenceAdjudicationLLMOutputSchema) as ParseableOutputFormat<unknown>,
  relationships: RELATIONSHIPS,
  buildUserPrompt: (a, b) => buildRecurrenceAdjudicationUserPrompt(a, b),
  normalize: (raw) => {
    const parsed = RecurrenceAdjudicationLLMOutputSchema.parse(raw);
    const enforced = enforceIssueNameInvariant(parsed);
    return {
      relationship: enforced.relationship,
      confidence: enforced.confidence,
      reasoning: enforced.reasoning,
      proposedName: enforced.proposedRecurringIssueName,
    };
  },
};

/**
 * Technical only. The workflow track has its own end-to-end path
 * (`intelligence:workflow-adjudicate`) built on the richer workflow embedding
 * record, with its own prompt, verdict vocabulary, and output file. Routing
 * workflow work through this spec would silently produce records missing the
 * fields grouping and reporting need, so it fails loudly instead.
 */
export function adjudicationSpecFor(category: PipelineCategory): AdjudicationSpec {
  if (category !== "technical") {
    throw new Error(
      `adjudicationSpecFor does not serve the "${category}" track. ` +
        "Use `npm run intelligence:workflow-adjudicate` for manual workflows.",
    );
  }
  return TECHNICAL_SPEC;
}
