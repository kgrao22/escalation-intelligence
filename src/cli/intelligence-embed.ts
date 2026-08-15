import fs from "node:fs/promises";
import path from "node:path";
import { EnvValidationError, requireVoyageApiKey } from "../config/env.js";
import { getEnv } from "../config/loadEnv.js";
import { DEFAULT_EMBEDDING_BATCH_SIZE } from "../embeddings/batching.js";
import { embedCandidates, planEmbeddingRun } from "../embeddings/runEmbedding.js";
import {
  assertExtractionPromptVersion,
  ExtractionVersionError,
  selectCandidatesForCategory,
  UnsafeEmbeddingPayloadError,
} from "../embeddings/selectCandidates.js";
import { createVoyageEmbedFn } from "../embeddings/voyageClient.js";
import {
  describeInputSelection,
  InputResolutionError,
  resolveInputFile,
} from "../persistence/resolveInput.js";
import {
  embeddingOutputFilePath,
  findReusableEmbeddingOutput,
  writeEmbeddingOutput,
  type EmbeddingOutput,
} from "../persistence/embeddingOutput.js";
import type { ExtractionOutput } from "../persistence/extractionOutput.js";
import { windowTagForDays } from "../persistence/datedFiles.js";
import { categoryLabel, filePrefixesFor } from "../categories.js";
import { parseEmbedArgs } from "./embedArgs.js";

const INTELLIGENCE_DATA_DIR = path.resolve(process.cwd(), "data", "intelligence");

function fail(message: string): never {
  console.error(message);
  console.log("");
  console.log("Embedding generation failed.");
  process.exit(1);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function listDataDir(): Promise<string[]> {
  try {
    return await fs.readdir(INTELLIGENCE_DATA_DIR);
  } catch {
    return [];
  }
}

async function loadPriorEmbeddingOutputs(filenames: string[], prefix: string): Promise<EmbeddingOutput[]> {
  const outputs: EmbeddingOutput[] = [];
  for (const filename of filenames) {
    if (!new RegExp(`^${prefix}(?:-\\d+d)?-\\d{4}-\\d{2}-\\d{2}\\.json$`).test(filename)) {
      continue;
    }
    try {
      outputs.push(await readJsonFile<EmbeddingOutput>(path.join(INTELLIGENCE_DATA_DIR, filename)));
    } catch {
      // A corrupt prior file simply doesn't qualify for reuse.
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

  const args = parseEmbedArgs(process.argv.slice(2));
  const prefixes = filePrefixesFor(args.category);
  const filenames = await listDataDir();

  let resolvedInput;
  try {
    resolvedInput = await resolveInputFile({
      explicitInput: args.input,
      defaultDir: INTELLIGENCE_DATA_DIR,
      prefix: "extractions",
      missingHint:
        "Run `npm run intelligence:extract` first, or pass --input=data/intelligence/extractions-90d-YYYY-MM-DD.json.",
    });
  } catch (err) {
    if (err instanceof InputResolutionError) {
      fail(`✗ ${err.message}`);
    }
    throw err;
  }

  const relativeInputPath = resolvedInput.relativePath;

  let extraction: ExtractionOutput;
  try {
    extraction = await readJsonFile<ExtractionOutput>(resolvedInput.absolutePath);
  } catch (err) {
    fail(`✗ Failed to read ${relativeInputPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const windowTag =
    resolvedInput.windowTag ??
    (typeof extraction.metadata.sourceWindowDays === "number"
      ? windowTagForDays(extraction.metadata.sourceWindowDays)
      : null);

  try {
    assertExtractionPromptVersion(extraction, relativeInputPath);
  } catch (err) {
    if (err instanceof ExtractionVersionError) {
      fail(`✗ ${err.message}`);
    }
    throw err;
  }

  const candidates = selectCandidatesForCategory(extraction, args.category);
  if (candidates.length === 0) {
    fail(`✗ ${relativeInputPath} contains no ${categoryLabel(args.category)} candidates with a statement to embed.`);
  }

  const plan = planEmbeddingRun(candidates, env.VOYAGE_EMBEDDING_MODEL, DEFAULT_EMBEDDING_BATCH_SIZE);

  console.log(`Escalation Intelligence — Embeddings${args.dryRun ? " (dry run)" : ""}`);
  console.log("");
  console.log("Input");
  for (const line of describeInputSelection(resolvedInput)) {
    console.log(line);
  }
  console.log(`✓ extraction prompt version: ${extraction.metadata.promptVersion}`);
  console.log(`✓ ${extraction.results.length} extraction results`);
  console.log(`✓ category: ${args.category}`);
  console.log(`✓ ${plan.eligibleCount} eligible ${categoryLabel(args.category)} candidates`);
  console.log("");

  if (args.dryRun) {
    console.log("Plan");
    console.log(`- model: ${plan.model}`);
    console.log(`- batch size: ${plan.batchSize}`);
    console.log(`- embedding API calls: ${plan.batchCount}`);
    console.log(
      `- output file: ${path.relative(process.cwd(), embeddingOutputFilePath(INTELLIGENCE_DATA_DIR, new Date(), windowTag, prefixes.embeddings))}`,
    );
    console.log("");
    console.log("Safety");
    console.log("✓ Zero Voyage API calls made");
    console.log("✓ No output file written");
    return;
  }

  const priorOutputs = await loadPriorEmbeddingOutputs(filenames, prefixes.embeddings);
  const reusable = findReusableEmbeddingOutput(priorOutputs, {
    inputFile: relativeInputPath,
    extractionPromptVersion: extraction.metadata.promptVersion,
    embeddingModel: env.VOYAGE_EMBEDDING_MODEL,
  });

  if (reusable) {
    console.log("Reuse");
    console.log("✓ Existing embeddings match this extraction file, prompt version, and model");
    console.log(`✓ ${reusable.embeddings.length} vectors reused — zero Voyage API calls made`);
    console.log("");
    console.log(`  Delete the existing ${prefixes.embeddings}-*.json file to force regeneration.`);
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

  const embedFn = createVoyageEmbedFn(apiKey);

  let result;
  try {
    result = await embedCandidates({
      candidates,
      embedFn,
      model: env.VOYAGE_EMBEDDING_MODEL,
      batchSize: DEFAULT_EMBEDDING_BATCH_SIZE,
      onBatchProgress: (batchIndex, batchCount, itemsInBatch) => {
        console.log(`[batch ${batchIndex}/${batchCount}] embedding ${itemsInBatch} statements...`);
      },
    });
  } catch (err) {
    if (err instanceof UnsafeEmbeddingPayloadError) {
      fail(`✗ ${err.message}\n  Nothing was sent to Voyage.`);
    }
    fail(`✗ Embedding failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const createdAt = new Date();
  const output: EmbeddingOutput = {
    metadata: {
      inputFile: relativeInputPath,
      createdAt: createdAt.toISOString(),
      extractionPromptVersion: extraction.metadata.promptVersion,
      embeddingModel: env.VOYAGE_EMBEDDING_MODEL,
      embeddingDimension: result.dimension,
      technicalEscalations: result.entries.length,
      category: args.category,
      ...(typeof extraction.metadata.sourceWindowDays === "number"
        ? { sourceWindowDays: extraction.metadata.sourceWindowDays }
        : {}),
    },
    embeddings: result.entries,
  };

  const outputFilePath = embeddingOutputFilePath(INTELLIGENCE_DATA_DIR, createdAt, windowTag, prefixes.embeddings);
  await writeEmbeddingOutput(output, outputFilePath);

  console.log("");
  console.log("Embeddings");
  console.log(`✓ ${result.entries.length} vectors generated`);
  console.log(`✓ model: ${env.VOYAGE_EMBEDDING_MODEL}`);
  console.log(`✓ dimension: ${result.dimension}`);
  console.log("");
  console.log("Output");
  console.log(`✓ ${path.relative(process.cwd(), outputFilePath)}`);
  console.log("");
  console.log("Only de-identified normalized problem statements were sent to Voyage.");
  console.log("Next: npm run intelligence:similarity");
}

main().catch((err: unknown) => {
  fail(`✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});
