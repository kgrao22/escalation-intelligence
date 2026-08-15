import type { PipelineCategory } from "../categories.js";
import type { ExtractionOutput } from "../persistence/extractionOutput.js";

/**
 * The workflow track needs fields that only exist from v3 onward, so both
 * tracks now require v3. Older extraction files must be regenerated rather
 * than silently reused with missing workflow data.
 */
export const REQUIRED_EXTRACTION_PROMPT_VERSION = "v3";

export class ExtractionVersionError extends Error {
  constructor(actual: string, required: string, inputFile: string) {
    super(
      `Extraction file ${inputFile} was produced with prompt version "${actual}", but embeddings require "${required}". ` +
        `Re-run \`npm run intelligence:extract\` to regenerate it with the current prompt.`,
    );
    this.name = "ExtractionVersionError";
  }
}

export class UnsafeEmbeddingPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeEmbeddingPayloadError";
  }
}

export interface EmbeddingCandidate {
  rootTs: string;
  /** The statement that gets embedded — problem or workflow, per category. */
  normalizedProblemStatement: string;
  classification: string;
  permalink: string | null;
  isTechnicalEscalation: boolean;
  /** Which track this candidate belongs to; guards against pool mixing. */
  category: PipelineCategory;
  /** Populated only for workflow candidates. */
  workflowClassification?: string | null;
  automationStatus?: string | null;
}

export function assertExtractionPromptVersion(
  output: ExtractionOutput,
  inputFile: string,
  required: string = REQUIRED_EXTRACTION_PROMPT_VERSION,
): void {
  if (output.metadata.promptVersion !== required) {
    throw new ExtractionVersionError(output.metadata.promptVersion, required, inputFile);
  }
}

/**
 * Selects exactly the items eligible for embedding: successful extractions
 * that the LLM judged to be genuine technical escalations and that carry a
 * normalized problem statement. Everything else — failures, non-technical
 * items, and technical items with a null statement — is excluded, so only
 * the generic technical problem pattern is ever embedded.
 */
export function selectEmbeddingCandidates(output: ExtractionOutput): EmbeddingCandidate[] {
  return output.results.flatMap((result) => {
    if (result.status !== "success" || !result.analysis) {
      return [];
    }

    const analysis = result.analysis;
    if (!analysis.isTechnicalEscalation || analysis.normalizedProblemStatement === null) {
      return [];
    }

    return [
      {
        rootTs: result.rootTs,
        normalizedProblemStatement: analysis.normalizedProblemStatement,
        classification: analysis.classification,
        permalink: analysis.permalink,
        isTechnicalEscalation: analysis.isTechnicalEscalation,
        category: "technical" as const,
      },
    ];
  });
}

/**
 * Selects repeatable manual workflows: successful extractions the LLM judged
 * automation-workflow candidates that carry a normalized workflow statement.
 *
 * Deliberately independent of isTechnicalEscalation — a routine backend task
 * that is not a defect belongs here, and a defect that also forces repeated
 * manual correction legitimately appears in both pools.
 */
export function selectWorkflowCandidates(output: ExtractionOutput): EmbeddingCandidate[] {
  return output.results.flatMap((result) => {
    if (result.status !== "success" || !result.analysis) {
      return [];
    }

    const analysis = result.analysis;
    if (!analysis.isAutomationWorkflowCandidate || analysis.normalizedWorkflowStatement === null) {
      return [];
    }

    return [
      {
        rootTs: result.rootTs,
        normalizedProblemStatement: analysis.normalizedWorkflowStatement,
        classification: analysis.workflowClassification ?? "other_operational_workflow",
        permalink: analysis.permalink,
        // Not a claim about the technical track; carried so the safety
        // assertion can tell which invariant applies to this candidate.
        isTechnicalEscalation: analysis.isTechnicalEscalation,
        category: "workflow" as const,
        workflowClassification: analysis.workflowClassification,
        automationStatus: analysis.automationStatus,
      },
    ];
  });
}

export function selectCandidatesForCategory(
  output: ExtractionOutput,
  category: PipelineCategory,
): EmbeddingCandidate[] {
  return category === "technical" ? selectEmbeddingCandidates(output) : selectWorkflowCandidates(output);
}

/**
 * Last line of defense before anything leaves the machine. Selection above
 * should already guarantee these properties; re-checking immediately before
 * the API call means a future change to selection cannot silently start
 * sending non-technical items or empty statements to a third party.
 */
export function assertEmbeddingCandidatesSafe(candidates: EmbeddingCandidate[]): void {
  const categories = new Set(candidates.map((candidate) => candidate.category));
  if (categories.size > 1) {
    // Mixing pools would let a defect statement and a manual-task statement
    // be compared as if they were the same kind of thing.
    throw new UnsafeEmbeddingPayloadError(
      `Refusing to embed a mixed candidate set (${[...categories].sort().join(", ")}). Technical and workflow pools must stay separate.`,
    );
  }

  for (const candidate of candidates) {
    // The technical invariant applies only to the technical pool; a workflow
    // candidate is legitimately non-technical.
    if (candidate.category === "technical" && candidate.isTechnicalEscalation !== true) {
      throw new UnsafeEmbeddingPayloadError(
        `Refusing to embed thread ${candidate.rootTs}: isTechnicalEscalation is not true.`,
      );
    }
    if (candidate.normalizedProblemStatement === null || candidate.normalizedProblemStatement.trim() === "") {
      throw new UnsafeEmbeddingPayloadError(
        `Refusing to embed thread ${candidate.rootTs}: the statement to embed is null or empty.`,
      );
    }
  }
}
