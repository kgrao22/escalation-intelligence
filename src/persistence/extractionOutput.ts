import fs from "node:fs/promises";
import path from "node:path";
import type { EnumNormalizationDiagnostic } from "../llm/enumNormalization.js";
import type { EscalationAnalysis } from "../llm/schemas/escalationAnalysis.js";
import { buildDatedFilename } from "./datedFiles.js";

export interface ExtractionResultItem {
  rootTs: string;
  status: "success" | "failed";
  analysis?: EscalationAnalysis;
  error?: string;
  /**
   * Present only when the model returned an enum value strict validation would
   * have rejected and it was rewritten onto a documented fallback. Persisted so
   * a normalized field is auditable rather than indistinguishable from a value
   * the model actually chose.
   */
  normalizations?: EnumNormalizationDiagnostic[];
}

export interface ExtractionRunMetadata {
  inputFile: string;
  analysedAt: string;
  promptVersion: string;
  model: string;
  threadsAvailable: number;
  threadsAnalysed: number;
  technicalEscalations: number;
  nonTechnical: number;
  failedExtractions: number;
  /** Additive prompt revision within promptVersion; absent on pre-v3.1 files. */
  promptRevision?: string;
  /**
   * The manual-workflow dimension, recorded so the counts are inspectable
   * without recomputing them from every result. Absent on pre-workflow files.
   */
  workflowCandidates?: number;
  nonWorkflow?: number;
  technicalAndWorkflow?: number;
  workflowOnly?: number;
  technicalOnly?: number;
  neither?: number;
  workflowClassificationCounts?: Record<string, number>;
  /** Lookback window of the source Slack fetch; absent on pre-tagging files. */
  sourceWindowDays?: number;
}

export interface ExtractionOutput {
  metadata: ExtractionRunMetadata;
  results: ExtractionResultItem[];
}

/** Carries the source window tag through, e.g. `extractions-90d-2026-08-09.json`. */
export function extractionOutputFilePath(
  baseDir: string,
  analysedAt: Date,
  windowTag?: string | null,
): string {
  return path.join(baseDir, buildDatedFilename("extractions", analysedAt, windowTag));
}

export async function writeExtractionOutput(output: ExtractionOutput, filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}

function priorResultKey(rootTs: string, promptVersion: string, model: string): string {
  return `${rootTs}::${promptVersion}::${model}`;
}

/**
 * Builds a lookup of already-successfully-analysed threads (keyed by
 * rootTs + promptVersion + model) from previously written extraction output
 * files, so a re-run can skip calling the LLM again for threads it already
 * has a good answer for. Only successes count — a failed prior attempt is
 * always worth retrying. Simple local JSON-based reuse, as scoped for this
 * milestone; a real "already processed" table can come later if needed.
 */
export function buildPriorResultsIndex(priorOutputs: ExtractionOutput[]): Map<string, ExtractionResultItem> {
  const index = new Map<string, ExtractionResultItem>();
  for (const output of priorOutputs) {
    for (const result of output.results) {
      if (result.status !== "success" || !result.analysis) {
        continue;
      }
      index.set(priorResultKey(result.rootTs, output.metadata.promptVersion, output.metadata.model), result);
    }
  }
  return index;
}

export function lookupPriorResult(
  index: Map<string, ExtractionResultItem>,
  rootTs: string,
  promptVersion: string,
  model: string,
): ExtractionResultItem | undefined {
  return index.get(priorResultKey(rootTs, promptVersion, model));
}
