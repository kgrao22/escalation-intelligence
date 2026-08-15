import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildCandidatePairs,
  buildExtractionIndex,
  describeCandidateDistribution,
} from "../adjudication/candidatePairs.js";
import { limitCandidates, runAdjudication, type AdjudicationProgressEvent } from "../adjudication/runAdjudication.js";
import { EnvValidationError, requireAnthropicApiKey } from "../config/env.js";
import { getEnv } from "../config/loadEnv.js";
import { computeAllPairs } from "../embeddings/nearestNeighbours.js";
import { createStructuredParseFn } from "../llm/structuredParse.js";
import {
  adjudicationOutputFilePath,
  buildPriorAdjudicationIndex,
  countRelationships,
  writeAdjudicationOutput,
  type AdjudicationOutput,
} from "../persistence/adjudicationOutput.js";
import { windowTagForDays } from "../persistence/datedFiles.js";
import { categoryLabel, filePrefixesFor } from "../categories.js";
import { adjudicationSpecFor } from "../adjudication/adjudicationSpec.js";
import type { EmbeddingOutput } from "../persistence/embeddingOutput.js";
import type { ExtractionOutput } from "../persistence/extractionOutput.js";
import { describeInputSelection, InputResolutionError, resolveInputFile } from "../persistence/resolveInput.js";
import { parseAdjudicateArgs } from "./adjudicateArgs.js";

const INTELLIGENCE_DATA_DIR = path.resolve(process.cwd(), "data", "intelligence");

/** One short verdict plus a sentence or two of reasoning — no long generation. */
const MAX_OUTPUT_TOKENS = 1024;

function fail(message: string): never {
  console.error(message);
  console.log("");
  console.log("Recurrence adjudication failed.");
  process.exit(1);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function loadPriorAdjudications(prefix: string): Promise<AdjudicationOutput[]> {
  let filenames: string[];
  try {
    filenames = await fs.readdir(INTELLIGENCE_DATA_DIR);
  } catch {
    return [];
  }

  const outputs: AdjudicationOutput[] = [];
  for (const filename of filenames) {
    if (!new RegExp(`^${prefix}(?:-\\d+d)?-\\d{4}-\\d{2}-\\d{2}\\.json$`).test(filename)) {
      continue;
    }
    try {
      outputs.push(await readJsonFile<AdjudicationOutput>(path.join(INTELLIGENCE_DATA_DIR, filename)));
    } catch {
      // A corrupt prior file simply doesn't contribute to resumability.
    }
  }
  return outputs;
}

function printProgress(event: AdjudicationProgressEvent): void {
  const prefix = `[${event.index}/${event.total}] ${event.similarity.toFixed(3)} ${event.pairId}`;
  if (event.outcome === "failed") {
    console.log(`${prefix} → ✗ ${event.errorMessage ?? "unknown error"}`);
    return;
  }
  console.log(`${prefix} → ${event.relationship}${event.outcome === "cached" ? " (cached)" : ""}`);
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
    args = parseAdjudicateArgs(process.argv.slice(2));
  } catch (err) {
    fail(`✗ ${err instanceof Error ? err.message : String(err)}`);
  }

  // The category picks the prompt, the schema, and every file prefix, so the two
  // tracks can never read each other's embeddings or resume from each other's verdicts.
  const spec = adjudicationSpecFor(args.category);
  const prefixes = filePrefixesFor(args.category);

  let embeddingsInput;
  let extractionsInput;
  try {
    embeddingsInput = await resolveInputFile({
      explicitInput: args.embeddings,
      defaultDir: INTELLIGENCE_DATA_DIR,
      prefix: prefixes.embeddings,
      missingHint: "Run `npm run intelligence:embed` first, or pass --embeddings=<path>.",
    });
    extractionsInput = await resolveInputFile({
      explicitInput: args.extractions,
      defaultDir: INTELLIGENCE_DATA_DIR,
      prefix: "extractions",
      missingHint: "Run `npm run intelligence:extract` first, or pass --extractions=<path>.",
    });
  } catch (err) {
    if (err instanceof InputResolutionError) {
      fail(`✗ ${err.message}`);
    }
    throw err;
  }

  let embeddings: EmbeddingOutput;
  let extraction: ExtractionOutput;
  try {
    embeddings = await readJsonFile<EmbeddingOutput>(embeddingsInput.absolutePath);
    extraction = await readJsonFile<ExtractionOutput>(extractionsInput.absolutePath);
  } catch (err) {
    fail(`✗ Failed to read input files: ${err instanceof Error ? err.message : String(err)}`);
  }

  const entries = embeddings.embeddings;
  if (entries.length < 2) {
    fail(`✗ Need at least 2 embeddings to form candidate pairs; found ${entries.length}.`);
  }

  const floor = args.floor ?? env.RECURRENCE_CANDIDATE_SIMILARITY;
  const allPairs = computeAllPairs(entries);
  const extractionIndex = buildExtractionIndex(extraction);
  const allCandidates = buildCandidatePairs(allPairs, floor, extractionIndex);
  const candidates = limitCandidates(allCandidates, args.limit);

  const joinMisses = allCandidates.filter(
    (candidate) => !extractionIndex.has(candidate.a.rootTs) || !extractionIndex.has(candidate.b.rootTs),
  ).length;

  console.log(`Escalation Intelligence — Recurrence Adjudication${args.dryRun ? " (dry run)" : ""}`);
  console.log("");
  console.log("Source");
  for (const line of describeInputSelection(embeddingsInput)) {
    console.log(line);
  }
  for (const line of describeInputSelection(extractionsInput)) {
    console.log(line);
  }
  console.log(`✓ category: ${args.category}`);
  console.log(`✓ ${entries.length} ${categoryLabel(args.category)} items`);
  console.log(`✓ ${allPairs.length} possible pairs`);
  console.log("");

  console.log("Candidate generation");
  console.log(`✓ similarity floor: ${floor} (candidate generation only — not a "same issue" threshold)`);
  console.log(`✓ ${allCandidates.length} candidate pairs`);
  if (args.limit !== undefined) {
    console.log(`✓ limited to ${candidates.length} for this run`);
  }
  if (joinMisses > 0) {
    console.log(`⚠ ${joinMisses} candidate pairs lack extraction data on one or both sides`);
  }
  console.log("");
  console.log("  Similarity spread among candidates:");
  for (const bucket of describeCandidateDistribution(candidates)) {
    console.log(`    ${bucket.label.padEnd(16)} ${String(bucket.count).padStart(5)}`);
  }
  console.log("");

  if (args.dryRun) {
    console.log("Plan");
    console.log(`- model: ${env.ANTHROPIC_MODEL}`);
    console.log(`- prompt version: ${spec.promptVersion}`);
    console.log(`- estimated Anthropic calls: ${candidates.length} (one per candidate pair, minus any reused)`);
    console.log("");
    console.log("Safety");
    console.log("✓ Zero Anthropic API calls made");
    console.log("✓ No output file written");
    return;
  }

  if (candidates.length === 0) {
    fail(`✗ No candidate pairs at or above the similarity floor of ${floor}. Nothing to adjudicate.`);
  }

  let apiKey: string;
  try {
    apiKey = requireAnthropicApiKey(env);
  } catch (err) {
    if (err instanceof EnvValidationError) {
      fail(`✗ ${err.message}`);
    }
    throw err;
  }

  const client = new Anthropic({ apiKey });
  const parseFn = createStructuredParseFn(client, spec.outputFormat, MAX_OUTPUT_TOKENS);

  // Only reuse verdicts derived from the SAME extraction file. The cache key
  // is (pairId + promptVersion + model) and carries no extraction provenance,
  // so without this filter a verdict computed on an earlier extraction's
  // problem statements would be reused for different text describing the same
  // two threads.
  const priorOutputs = (await loadPriorAdjudications(prefixes.adjudications)).filter(
    (output) => output.metadata.extractionsInputFile === extractionsInput.relativePath,
  );
  const priorIndex = buildPriorAdjudicationIndex(priorOutputs);
  console.log(
    `✓ resumability scoped to ${priorOutputs.length} prior run(s) from the same extraction file`,
  );

  console.log("LLM adjudication");
  console.log("");
  const results = await runAdjudication({
    candidates,
    parseFn,
    model: env.ANTHROPIC_MODEL,
    promptVersion: spec.promptVersion,
    spec,
    priorIndex,
    onProgress: printProgress,
  });

  const createdAt = new Date();
  const counts = countRelationships(results);
  const failures = results.filter((result) => result.status === "failed").length;
  const windowTag =
    embeddingsInput.windowTag ??
    (typeof embeddings.metadata.sourceWindowDays === "number"
      ? windowTagForDays(embeddings.metadata.sourceWindowDays)
      : null);

  const output: AdjudicationOutput = {
    metadata: {
      embeddingsInputFile: embeddingsInput.relativePath,
      extractionsInputFile: extractionsInput.relativePath,
      createdAt: createdAt.toISOString(),
      model: env.ANTHROPIC_MODEL,
      promptVersion: spec.promptVersion,
      candidateSimilarityFloor: floor,
      totalEmbeddingPairs: allPairs.length,
      candidatePairs: allCandidates.length,
      adjudicated: results.length - failures,
      failures,
      relationshipCounts: counts,
      category: args.category,
      ...(typeof embeddings.metadata.sourceWindowDays === "number"
        ? { sourceWindowDays: embeddings.metadata.sourceWindowDays }
        : {}),
    },
    results,
  };

  const outputFilePath = adjudicationOutputFilePath(INTELLIGENCE_DATA_DIR, createdAt, windowTag, prefixes.adjudications);
  await writeAdjudicationOutput(output, outputFilePath);

  console.log("");
  console.log("Results");
  for (const relationship of spec.relationships) {
    console.log(`✓ ${relationship.toUpperCase().padEnd(23)} ${counts[relationship] ?? 0}`);
  }
  console.log(`✓ failed:                 ${failures}`);
  console.log("");
  console.log("Output");
  console.log(`✓ ${path.relative(process.cwd(), outputFilePath)}`);
  console.log("");
  console.log("Only de-identified structured extraction data was sent to Claude.");
  console.log("No Slack messages were posted.");
}

main().catch((err: unknown) => {
  fail(`✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});
