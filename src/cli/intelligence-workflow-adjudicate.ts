import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import fs from "node:fs/promises";
import path from "node:path";
import { EnvValidationError, requireAnthropicApiKey } from "../config/env.js";
import { getEnv } from "../config/loadEnv.js";
import { WORKFLOW_ADJUDICATION_PROMPT_VERSION } from "../llm/prompts/workflowAdjudication.js";
import { WorkflowAdjudicationLLMOutputSchema } from "../llm/schemas/workflowAdjudication.js";
import { createStructuredParseFn, type ParseableOutputFormat } from "../llm/structuredParse.js";
import { windowTagForDays } from "../persistence/datedFiles.js";
import { describeInputSelection, InputResolutionError, resolveInputFile } from "../persistence/resolveInput.js";
import {
  buildWorkflowAdjudicationCache,
  countWorkflowRelationships,
  workflowAdjudicationOutputFilePath,
  writeWorkflowAdjudicationOutput,
  type WorkflowAdjudicationOutput,
} from "../persistence/workflowAdjudicationOutput.js";
import type { WorkflowEmbeddingOutput } from "../persistence/workflowEmbeddingOutput.js";
import {
  runWorkflowAdjudication,
  type WorkflowAdjudicationProgressEvent,
} from "../workflow/runWorkflowAdjudication.js";
import {
  buildWorkflowCandidatePairs,
  describeWorkflowCandidateDistribution,
  filterBySimilarityBand,
  limitWorkflowCandidates,
} from "../workflow/workflowCandidatePairs.js";
import { parseWorkflowAdjudicateArgs } from "./workflowAdjudicateArgs.js";

const INTELLIGENCE_DATA_DIR = path.resolve(process.cwd(), "data", "intelligence");

/** One short verdict plus a sentence or two of reasoning — no long generation. */
const MAX_OUTPUT_TOKENS = 1024;

function fail(message: string): never {
  console.error(message);
  console.log("");
  console.log("Workflow adjudication failed.");
  process.exit(1);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function loadPriorWorkflowAdjudications(): Promise<WorkflowAdjudicationOutput[]> {
  let filenames: string[];
  try {
    filenames = await fs.readdir(INTELLIGENCE_DATA_DIR);
  } catch {
    return [];
  }

  const outputs: WorkflowAdjudicationOutput[] = [];
  for (const filename of filenames.sort()) {
    if (!/^workflow-adjudications(?:-\d+d)?-\d{4}-\d{2}-\d{2}\.json$/.test(filename)) {
      continue;
    }
    try {
      outputs.push(await readJsonFile<WorkflowAdjudicationOutput>(path.join(INTELLIGENCE_DATA_DIR, filename)));
    } catch {
      // A corrupt prior file simply doesn't contribute to resumability.
    }
  }
  return outputs;
}

function printProgress(event: WorkflowAdjudicationProgressEvent): void {
  const prefix = `[${event.index}/${event.total}] ${event.similarity.toFixed(4)} ${event.pairId}`;
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
    args = parseWorkflowAdjudicateArgs(process.argv.slice(2));
  } catch (err) {
    fail(`✗ ${err instanceof Error ? err.message : String(err)}`);
  }

  let resolvedInput;
  try {
    resolvedInput = await resolveInputFile({
      explicitInput: args.embeddings,
      defaultDir: INTELLIGENCE_DATA_DIR,
      prefix: "workflow-embeddings",
      missingHint: "Run `npm run intelligence:workflow-embed` first, or pass --embeddings=<path>.",
    });
  } catch (err) {
    if (err instanceof InputResolutionError) {
      fail(`✗ ${err.message}`);
    }
    throw err;
  }

  let embeddings: WorkflowEmbeddingOutput;
  try {
    embeddings = await readJsonFile<WorkflowEmbeddingOutput>(resolvedInput.absolutePath);
    if (!Array.isArray(embeddings.embeddings)) {
      throw new Error("missing or invalid `embeddings` array");
    }
  } catch (err) {
    fail(`✗ Failed to read ${resolvedInput.relativePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (embeddings.metadata?.embeddedField !== "normalizedWorkflowStatement") {
    fail(
      `✗ ${resolvedInput.relativePath} is not a workflow embedding file ` +
        `(embeddedField: ${String(embeddings.metadata?.embeddedField)}). Refusing to adjudicate technical vectors here.`,
    );
  }

  const entries = embeddings.embeddings;
  if (entries.length < 2) {
    fail(`✗ Need at least 2 workflow embeddings to form pairs; found ${entries.length}.`);
  }

  const possiblePairs = (entries.length * (entries.length - 1)) / 2;
  const allCandidates = buildWorkflowCandidatePairs(entries, args.floor);
  // Band selection happens BEFORE the limit, so `--limit=20` inside a band
  // means the top 20 of that band, not the top 20 overall.
  const banded = filterBySimilarityBand(allCandidates, {
    min: args.minSimilarity,
    max: args.maxSimilarity,
  });
  const candidates = limitWorkflowCandidates(banded, args.limit);
  const crossClassification = allCandidates.filter((pair) => !pair.sameClassification).length;
  const bandActive = args.minSimilarity !== undefined || args.maxSimilarity !== undefined;

  console.log(`Escalation Intelligence — Workflow Recurrence Adjudication${args.dryRun ? " (dry run)" : ""}`);
  console.log("");
  console.log("Source");
  for (const line of describeInputSelection(resolvedInput)) {
    console.log(line);
  }
  console.log(`✓ embedded field: ${embeddings.metadata.embeddedField}`);
  console.log(`✓ ${entries.length} workflow embeddings`);
  console.log(`✓ ${possiblePairs} possible pairs`);
  console.log("");

  console.log("Candidate generation");
  console.log(`✓ similarity floor: ${args.floor} (candidate generation only — NOT a "same workflow" threshold)`);
  console.log(`✓ ${allCandidates.length} candidate pairs`);
  console.log(`✓ ${crossClassification} cross-classification candidates retained (never filtered)`);
  if (bandActive) {
    const lower = args.minSimilarity ?? args.floor;
    const upper = args.maxSimilarity;
    console.log(
      `✓ band: >= ${lower}${upper === undefined ? "" : ` and < ${upper}`} → ${banded.length} pairs in band`,
    );
  }
  if (args.limit !== undefined) {
    console.log(`✓ limited to ${candidates.length} for this run (band applied first)`);
  }
  console.log("");
  console.log("  Similarity spread among candidates:");
  for (const bucket of describeWorkflowCandidateDistribution(candidates)) {
    console.log(`    ${bucket.label.padEnd(16)} ${String(bucket.count).padStart(5)}`);
  }
  console.log("");

  // Only reuse verdicts derived from the SAME workflow-embeddings artifact. The
  // cache key is (pairId + promptVersion + model) and pairId is just a sorted
  // rootTs pair, so a thread present in two windows collides across them — and
  // the verdict depends on the workflow statements those embeddings were built
  // from. Scoping by the upstream artifact makes reuse structurally correct
  // rather than accidentally correct.
  const priorOutputs = (await loadPriorWorkflowAdjudications()).filter(
    (output) => output.metadata.inputFile === resolvedInput.relativePath,
  );
  const cache = buildWorkflowAdjudicationCache(priorOutputs);
  console.log(
    `✓ resumability scoped to ${priorOutputs.length} prior run(s) over ${resolvedInput.relativePath}`,
  );
  console.log("");

  if (args.inspect) {
    console.log(`Inspecting ${candidates.length} candidate pairs (local only)`);
    console.log("");
    candidates.forEach((pair, index) => {
      const cached = cache.get(
        `${pair.pairId}::${WORKFLOW_ADJUDICATION_PROMPT_VERSION}::${env.ANTHROPIC_MODEL}`,
      );
      const verdict = cached?.relationship ? `  [cached: ${cached.relationship}]` : "";
      console.log(
        `${index + 1}. similarity ${pair.similarity.toFixed(4)}  [${pair.sameClassification ? "same" : "cross"}-classification]${verdict}`,
      );
      console.log(`   A (${pair.a.workflowClassification ?? "unclassified"} / ${pair.a.automationStatus} / ${pair.a.nature})`);
      console.log(`     ${pair.a.normalizedWorkflowStatement}`);
      console.log(`     ${pair.a.permalink ?? "(no permalink)"}`);
      console.log(`   B (${pair.b.workflowClassification ?? "unclassified"} / ${pair.b.automationStatus} / ${pair.b.nature})`);
      console.log(`     ${pair.b.normalizedWorkflowStatement}`);
      console.log(`     ${pair.b.permalink ?? "(no permalink)"}`);
      console.log("");
    });

    console.log("Safety");
    console.log("✓ Zero Anthropic API calls made");
    console.log("✓ No output file written");
    console.log("✓ Nothing was posted to Slack");
    return;
  }
  const reusable = candidates.filter(
    (pair) =>
      cache.get(`${pair.pairId}::${WORKFLOW_ADJUDICATION_PROMPT_VERSION}::${env.ANTHROPIC_MODEL}`) !== undefined,
  ).length;

  if (args.dryRun) {
    console.log("Plan");
    console.log(`- model: ${env.ANTHROPIC_MODEL}`);
    console.log(`- prompt version: ${WORKFLOW_ADJUDICATION_PROMPT_VERSION}`);
    console.log(`- reusable from cache: ${reusable}`);
    console.log(`- estimated Anthropic calls: ${candidates.length - reusable}`);
    console.log(
      `- output file: ${path.relative(process.cwd(), workflowAdjudicationOutputFilePath(INTELLIGENCE_DATA_DIR, new Date(), resolvedInput.windowTag))}`,
    );
    console.log("");
    console.log("Safety");
    console.log("✓ Zero Anthropic API calls made");
    console.log("✓ No output file written");
    console.log("✓ Only de-identified workflow statements, classifications, automation status,");
    console.log("  nature, and cosine similarity would be transmitted — no rootTs, permalink, or vectors");
    return;
  }

  if (candidates.length === 0) {
    fail(`✗ No candidate pairs at or above the similarity floor of ${args.floor}. Nothing to adjudicate.`);
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
  const parseFn = createStructuredParseFn(
    client,
    zodOutputFormat(WorkflowAdjudicationLLMOutputSchema) as ParseableOutputFormat<unknown>,
    MAX_OUTPUT_TOKENS,
  );

  console.log("LLM adjudication");
  console.log("");
  const results = await runWorkflowAdjudication({
    candidates,
    parseFn,
    model: env.ANTHROPIC_MODEL,
    promptVersion: WORKFLOW_ADJUDICATION_PROMPT_VERSION,
    cache,
    onProgress: printProgress,
  });

  const createdAt = new Date();
  const counts = countWorkflowRelationships(results);
  const failed = results.filter((result) => result.status === "failed").length;
  const windowTag =
    resolvedInput.windowTag ??
    (typeof embeddings.metadata.sourceWindowDays === "number"
      ? windowTagForDays(embeddings.metadata.sourceWindowDays)
      : null);

  const output: WorkflowAdjudicationOutput = {
    metadata: {
      inputFile: resolvedInput.relativePath,
      createdAt: createdAt.toISOString(),
      ...(typeof embeddings.metadata.sourceWindowDays === "number"
        ? { sourceWindowDays: embeddings.metadata.sourceWindowDays }
        : {}),
      similarityFloor: args.floor,
      totalEmbeddings: entries.length,
      possiblePairs,
      candidatePairs: allCandidates.length,
      adjudicatedPairs: results.length - failed,
      ...counts,
      failed,
      reusedFromCache: reusable,
      crossClassificationCandidates: crossClassification,
      model: env.ANTHROPIC_MODEL,
      promptVersion: WORKFLOW_ADJUDICATION_PROMPT_VERSION,
      category: "workflow",
    },
    results,
  };

  const outputFilePath = workflowAdjudicationOutputFilePath(INTELLIGENCE_DATA_DIR, createdAt, windowTag);
  await writeWorkflowAdjudicationOutput(output, outputFilePath);

  console.log("");
  console.log("Results");
  console.log(`✓ SAME_UNDERLYING_WORKFLOW: ${counts.sameUnderlyingWorkflow}`);
  console.log(`✓ RELATED_WORKFLOW_FAMILY:  ${counts.relatedWorkflowFamily}`);
  console.log(`✓ DIFFERENT:                ${counts.different}`);
  console.log(`✓ failed:                   ${failed}`);
  console.log("");
  console.log("Output");
  console.log(`✓ ${path.relative(process.cwd(), outputFilePath)}`);
  console.log("");
  console.log("Only de-identified structured workflow data was sent to Claude.");
  console.log("No rootTs, permalink, or vector left this machine.");
  console.log("No Slack messages were posted.");
}

main().catch((err: unknown) => {
  fail(`✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});
