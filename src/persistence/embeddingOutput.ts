import fs from "node:fs/promises";
import path from "node:path";
import { buildDatedFilename } from "./datedFiles.js";

export interface EmbeddingEntry {
  rootTs: string;
  normalizedProblemStatement: string;
  classification: string;
  permalink: string | null;
  vector: number[];
}

export interface EmbeddingRunMetadata {
  inputFile: string;
  createdAt: string;
  extractionPromptVersion: string;
  embeddingModel: string;
  embeddingDimension: number;
  technicalEscalations: number;
  /** Which intelligence track these vectors belong to. */
  category?: "technical" | "workflow";
  /** Lookback window of the originating Slack fetch; absent on pre-tagging files. */
  sourceWindowDays?: number;
}

export interface EmbeddingOutput {
  metadata: EmbeddingRunMetadata;
  embeddings: EmbeddingEntry[];
}

/** Carries the source window tag through, e.g. `embeddings-90d-2026-08-09.json`. */
export function embeddingOutputFilePath(
  baseDir: string,
  createdAt: Date,
  windowTag?: string | null,
  prefix = "embeddings",
): string {
  return path.join(baseDir, buildDatedFilename(prefix, createdAt, windowTag));
}

export async function writeEmbeddingOutput(output: EmbeddingOutput, filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}

export interface ReuseCriteria {
  inputFile: string;
  extractionPromptVersion: string;
  embeddingModel: string;
}

/**
 * Finds an existing embeddings file generated from the same extraction file,
 * with the same extraction prompt version and embedding model. Those three
 * fully determine the vectors, so a match can be reused instead of paying
 * for the API again. Changing the model or regenerating extractions under a
 * new prompt version produces no match, which forces a fresh run.
 */
export function findReusableEmbeddingOutput(
  priorOutputs: EmbeddingOutput[],
  criteria: ReuseCriteria,
): EmbeddingOutput | undefined {
  return priorOutputs.find(
    (output) =>
      output.metadata.inputFile === criteria.inputFile &&
      output.metadata.extractionPromptVersion === criteria.extractionPromptVersion &&
      output.metadata.embeddingModel === criteria.embeddingModel,
  );
}
