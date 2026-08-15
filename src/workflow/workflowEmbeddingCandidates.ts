import type { ExtractionOutput } from "../persistence/extractionOutput.js";

export class UnsafeWorkflowPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeWorkflowPayloadError";
  }
}

/**
 * Everything the later adjudication and reporting stages need about one
 * manual-workflow occurrence. Note `statement` is the ONLY field that is ever
 * sent to the embedding provider; every other field is local metadata.
 */
export interface WorkflowEmbeddingCandidate {
  rootTs: string;
  permalink: string | null;
  /** The de-identified normalizedWorkflowStatement — the sole embed input. */
  statement: string;
  workflowClassification: string | null;
  automationStatus: string;
  isTechnicalEscalation: boolean;
  classification: string;
  affectedSystem: string | null;
  resolutionStatus: string;
  automationCandidate: string;
  nature: "technical+workflow" | "workflow-only";
}

/**
 * Selects the manual-workflow pool. Deliberately reads
 * `normalizedWorkflowStatement` and never `normalizedProblemStatement` — a
 * technical defect's problem text describes what broke, not the repeatable
 * task, and mixing the two would compare unlike things.
 */
export function selectWorkflowEmbeddingCandidates(output: ExtractionOutput): WorkflowEmbeddingCandidate[] {
  const candidates: WorkflowEmbeddingCandidate[] = [];

  for (const result of output.results) {
    if (result.status !== "success" || !result.analysis) {
      continue;
    }
    const analysis = result.analysis;
    if (analysis.isAutomationWorkflowCandidate !== true) {
      continue;
    }
    const statement = analysis.normalizedWorkflowStatement;
    if (typeof statement !== "string" || statement.trim() === "") {
      continue;
    }

    candidates.push({
      rootTs: result.rootTs,
      permalink: analysis.permalink ?? null,
      statement,
      workflowClassification: analysis.workflowClassification ?? null,
      automationStatus: analysis.automationStatus,
      isTechnicalEscalation: analysis.isTechnicalEscalation,
      classification: analysis.classification,
      affectedSystem: analysis.affectedSystem ?? null,
      resolutionStatus: analysis.resolutionStatus,
      automationCandidate: analysis.automationCandidate,
      nature: analysis.isTechnicalEscalation ? "technical+workflow" : "workflow-only",
    });
  }

  return candidates;
}

/** Identifier shapes that must never reach the embedding provider. */
const FORBIDDEN_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "email address", pattern: /[\w.+-]+@[\w-]+\.[\w.]+/ },
  { label: "Slack permalink", pattern: /https?:\/\/[\w.-]*slack\.com\/\S+/i },
  { label: "HubSpot URL", pattern: /https?:\/\/\S*hubspot\S*/i },
  { label: "Stripe-style identifier", pattern: /\b(?:cus|sub|pi|in|price|prod|acct)_[A-Za-z0-9]{6,}\b/ },
  { label: "UUID", pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  { label: "Slack user mention", pattern: /<@U[A-Z0-9]+>/ },
  { label: "long numeric identifier", pattern: /\b\d{6,}\b/ },
];

/**
 * The privacy gate. Runs before any network call, on every path. It inspects
 * exactly the strings that will be transmitted — not the candidate objects —
 * so it cannot be fooled by metadata that never leaves the machine.
 */
export function assertWorkflowPayloadSafe(candidates: WorkflowEmbeddingCandidate[]): void {
  for (const candidate of candidates) {
    if (typeof candidate.statement !== "string" || candidate.statement.trim() === "") {
      throw new UnsafeWorkflowPayloadError(
        `Refusing to embed thread ${candidate.rootTs}: the workflow statement is empty.`,
      );
    }
    if (candidate.isTechnicalEscalation === undefined) {
      throw new UnsafeWorkflowPayloadError(`Refusing to embed thread ${candidate.rootTs}: incomplete record.`);
    }
    for (const { label, pattern } of FORBIDDEN_PATTERNS) {
      if (pattern.test(candidate.statement)) {
        throw new UnsafeWorkflowPayloadError(
          `Refusing to embed thread ${candidate.rootTs}: workflow statement contains a ${label}.`,
        );
      }
    }
  }
}

/** The exact payload that will be transmitted, for assertion in tests and dry runs. */
export function workflowEmbedPayload(candidates: WorkflowEmbeddingCandidate[]): string[] {
  return candidates.map((candidate) => candidate.statement);
}

export function countWorkflowClassifications(
  candidates: WorkflowEmbeddingCandidate[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const candidate of candidates) {
    const key = candidate.workflowClassification ?? "(unclassified)";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}
