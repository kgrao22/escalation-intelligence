import fs from "node:fs/promises";
import path from "node:path";
import { parseWorkflowEmbedArgs } from "./workflowEmbedArgs.js";
import { EnvValidationError, requireVoyageApiKey } from "../config/env.js";
import { getEnv } from "../config/loadEnv.js";
import { DEFAULT_EMBEDDING_BATCH_SIZE } from "../embeddings/batching.js";
import { createVoyageEmbedFn } from "../embeddings/voyageClient.js";
import { windowTagForDays } from "../persistence/datedFiles.js";
import type { ExtractionOutput } from "../persistence/extractionOutput.js";
import { describeInputSelection, InputResolutionError, resolveInputFile } from "../persistence/resolveInput.js";
import {
  buildWorkflowEmbeddingCache,
  workflowEmbeddingOutputFilePath,
  writeWorkflowEmbeddingOutput,
  type WorkflowEmbeddingOutput,
} from "../persistence/workflowEmbeddingOutput.js";
import { embedWorkflowCandidates, planWorkflowEmbeddingRun } from "../workflow/runWorkflowEmbedding.js";
import {
  assertWorkflowPayloadSafe,
  countWorkflowClassifications,
  selectWorkflowEmbeddingCandidates,
  UnsafeWorkflowPayloadError,
} from "../workflow/workflowEmbeddingCandidates.js";

const INTELLIGENCE_DATA_DIR = path.resolve(process.cwd(), "data", "intelligence");

function fail(message: string): never {
  console.error(message);
  console.log("");
  console.log("Workflow embedding failed.");
  process.exit(1);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function loadPriorWorkflowEmbeddings(): Promise<WorkflowEmbeddingOutput[]> {
  let filenames: string[];
  try {
    filenames = await fs.readdir(INTELLIGENCE_DATA_DIR);
  } catch {
    return [];
  }

  const outputs: WorkflowEmbeddingOutput[] = [];
  for (const filename of filenames.sort()) {
    if (!/^workflow-embeddings(?:-\d+d)?-\d{4}-\d{2}-\d{2}\.json$/.test(filename)) {
      continue;
    }
    try {
      outputs.push(await readJsonFile<WorkflowEmbeddingOutput>(path.join(INTELLIGENCE_DATA_DIR, filename)));
    } catch {
      // A corrupt prior file simply doesn't contribute to the cache.
    }
  }
  return outputs;
}

async function main() {
  let env;
  try {
    env = getEnv();
  } catch (err) {
    if (err instanceof EnvValidationError) {
      fail(`✗ ${err.message}`);
    }
    throw err;
  }

  let args;
  try {
    args = parseWorkflowEmbedArgs(process.argv.slice(2));
  } catch (err) {
    fail(`✗ ${err instanceof Error ? err.message : String(err)}`);
  }

  let resolvedInput;
  try {
    resolvedInput = await resolveInputFile({
      explicitInput: args.input,
      defaultDir: INTELLIGENCE_DATA_DIR,
      prefix: "extractions",
      missingHint: "Run `npm run intelligence:extract` first, or pass --input=<path>.",
    });
  } catch (err) {
    if (err instanceof InputResolutionError) {
      fail(`✗ ${err.message}`);
    }
    throw err;
  }

  let extraction: ExtractionOutput;
  try {
    extraction = await readJsonFile<ExtractionOutput>(resolvedInput.absolutePath);
    if (!Array.isArray(extraction.results)) {
      throw new Error("missing or invalid `results` array");
    }
  } catch (err) {
    fail(`✗ Failed to read ${resolvedInput.relativePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const successfulRecords = extraction.results.filter((result) => result.status === "success").length;
  const allCandidates = selectWorkflowEmbeddingCandidates(extraction);
  const candidates = args.limit === undefined ? allCandidates : allCandidates.slice(0, args.limit);

  if (candidates.length === 0) {
    fail(`✗ ${resolvedInput.relativePath} contains no workflow candidates with a non-empty statement.`);
  }

  // Fail before anything else if a statement would leak an identifier.
  try {
    assertWorkflowPayloadSafe(candidates);
  } catch (err) {
    if (err instanceof UnsafeWorkflowPayloadError) {
      fail(`✗ ${err.message}\n  Nothing was sent to Voyage.`);
    }
    throw err;
  }

  const windowTag =
    resolvedInput.windowTag ??
    (typeof extraction.metadata.sourceWindowDays === "number"
      ? windowTagForDays(extraction.metadata.sourceWindowDays)
      : null);

  const cache = buildWorkflowEmbeddingCache(await loadPriorWorkflowEmbeddings());
  const plan = planWorkflowEmbeddingRun(candidates, env.VOYAGE_EMBEDDING_MODEL, cache);
  const classificationCounts = countWorkflowClassifications(candidates);

  console.log(`Escalation Intelligence — Workflow Embeddings${args.dryRun ? " (dry run)" : ""}`);
  console.log("");
  console.log("Input");
  for (const line of describeInputSelection(resolvedInput)) {
    console.log(line);
  }
  console.log(`✓ extraction prompt: ${extraction.metadata.promptVersion}${extraction.metadata.promptRevision ? ` (${extraction.metadata.promptRevision})` : ""}`);
  console.log(`✓ ${successfulRecords} successful extraction records`);
  console.log(`✓ ${allCandidates.length} workflow candidates`);
  if (args.limit !== undefined) {
    console.log(`✓ limited to ${candidates.length} for this run`);
  }
  console.log(`✓ ${plan.toEmbed} to embed (${plan.reusable} reusable from cache)`);
  console.log("");

  console.log("Workflow types");
  const width = Math.max(...Object.keys(classificationCounts).map((key) => key.length));
  for (const [type, count] of Object.entries(classificationCounts)) {
    console.log(`  ${type.padEnd(width)}  ${count}`);
  }
  console.log("");

  console.log("Nature");
  console.log(`  technical+workflow  ${candidates.filter((c) => c.nature === "technical+workflow").length}`);
  console.log(`  workflow-only       ${candidates.filter((c) => c.nature === "workflow-only").length}`);
  console.log("");

  console.log("Estimated payload");
  console.log(`- total statement text: ${plan.totalPayloadChars} characters`);
  console.log(`- average per statement: ${plan.averageCharsPerStatement} characters`);
  console.log(`- approx. tokens: ~${plan.approxTotalTokens} (rough estimate, not a real token count)`);
  console.log("");

  if (args.dryRun) {
    console.log("Plan");
    console.log(`- model: ${plan.model}`);
    console.log(`- batch size: ${plan.batchSize}`);
    console.log(`- embedding API calls: ${plan.batchCount}`);
    console.log(
      `- output file: ${path.relative(process.cwd(), workflowEmbeddingOutputFilePath(INTELLIGENCE_DATA_DIR, new Date(), windowTag))}`,
    );
    console.log("");
    console.log("Safety");
    console.log("✓ Zero Voyage API calls made");
    console.log("✓ No output file written");
    console.log("✓ Only normalizedWorkflowStatement values would be transmitted");
    return;
  }

  let apiKey: string;
  try {
    apiKey = requireVoyageApiKey(env);
  } catch (err) {
    if (err instanceof EnvValidationError) {
      fail(`✗ ${err.message}`);
    }
    throw err;
  }

  let result;
  try {
    result = await embedWorkflowCandidates({
      candidates,
      embedFn: createVoyageEmbedFn(apiKey),
      model: env.VOYAGE_EMBEDDING_MODEL,
      cache,
      batchSize: DEFAULT_EMBEDDING_BATCH_SIZE,
      onBatchProgress: (batchIndex, batchCount, itemsInBatch) => {
        console.log(`[batch ${batchIndex}/${batchCount}] embedding ${itemsInBatch} workflow statements...`);
      },
    });
  } catch (err) {
    if (err instanceof UnsafeWorkflowPayloadError) {
      fail(`✗ ${err.message}\n  Nothing was sent to Voyage.`);
    }
    fail(`✗ Workflow embedding failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const createdAt = new Date();
  const output: WorkflowEmbeddingOutput = {
    metadata: {
      inputFile: resolvedInput.relativePath,
      createdAt: createdAt.toISOString(),
      ...(typeof extraction.metadata.sourceWindowDays === "number"
        ? { sourceWindowDays: extraction.metadata.sourceWindowDays }
        : {}),
      embeddingModel: env.VOYAGE_EMBEDDING_MODEL,
      embeddingDimension: result.dimension,
      workflowCandidatesAvailable: allCandidates.length,
      successfullyEmbedded: result.entries.length,
      failed: result.failed,
      workflowClassificationCounts: classificationCounts,
      extractionPromptVersion: extraction.metadata.promptVersion,
      ...(extraction.metadata.promptRevision
        ? { extractionPromptRevision: extraction.metadata.promptRevision }
        : {}),
      extractionModel: extraction.metadata.model,
      category: "workflow",
      embeddedField: "normalizedWorkflowStatement",
      reusedFromCache: result.reusedFromCache,
    },
    embeddings: result.entries,
  };

  const outputFilePath = workflowEmbeddingOutputFilePath(INTELLIGENCE_DATA_DIR, createdAt, windowTag);
  await writeWorkflowEmbeddingOutput(output, outputFilePath);

  console.log("");
  console.log("Embeddings");
  console.log(`✓ ${result.entries.length} vectors (${result.reusedFromCache} reused from cache)`);
  console.log(`✓ model: ${env.VOYAGE_EMBEDDING_MODEL}`);
  console.log(`✓ dimension: ${result.dimension}`);
  console.log(`✓ failed: ${result.failed}`);
  console.log("");
  console.log("Output");
  console.log(`✓ ${path.relative(process.cwd(), outputFilePath)}`);
  console.log("");
  console.log("Only de-identified normalizedWorkflowStatement values were sent to Voyage.");
  console.log("Technical embeddings were not read or modified.");
  console.log("Next: npm run intelligence:workflow-similarity");
}

main().catch((err: unknown) => {
  fail(`✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});
