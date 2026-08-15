import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import path from "node:path";
import { EnvValidationError, requireAnthropicApiKey } from "../config/env.js";
import { getEnv } from "../config/loadEnv.js";
import { createAnthropicParseFn } from "../llm/anthropicParseClient.js";
import {
  ESCALATION_EXTRACTION_PROMPT_REVISION,
  ESCALATION_EXTRACTION_PROMPT_VERSION,
} from "../llm/prompts/escalationExtraction.js";
import {
  analyzeThreads,
  buildExtractionMetadata,
  computeExtractionTargets,
  estimateDryRunStats,
  failedRootTsValues,
  mergeRepairedResults,
  type ProgressEvent,
} from "../llm/runExtraction.js";
import {
  buildPriorResultsIndex,
  extractionOutputFilePath,
  writeExtractionOutput,
  type ExtractionOutput,
} from "../persistence/extractionOutput.js";
import { windowTagForDays } from "../persistence/datedFiles.js";
import {
  describeInputSelection,
  InputResolutionError,
  resolveInputFile,
} from "../persistence/resolveInput.js";
import type { EscalationThread } from "../slack/escalationThreads.js";
import { describeNormalization } from "../llm/enumNormalization.js";
import {
  computeWorkflowBreakdown,
  countWorkflowClassifications,
  describeFailedEnumFields,
} from "../workflow/workflowStats.js";
import { parseExtractArgs } from "./extractArgs.js";

const SLACK_DATA_DIR = path.resolve(process.cwd(), "data", "slack");
const INTELLIGENCE_DATA_DIR = path.resolve(process.cwd(), "data", "intelligence");

function fail(message: string): never {
  console.error(message);
  console.log("");
  console.log("LLM extraction failed.");
  process.exit(1);
}

interface FetchFile {
  metadata: { channelId: string; daysBack?: number };
  threads: EscalationThread[];
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

/** Absolute path of each prior extraction file, paired with its parsed content. */
async function loadPriorExtractionFiles(): Promise<Array<{ absolutePath: string; output: ExtractionOutput }>> {
  let filenames: string[];
  try {
    filenames = await fs.readdir(INTELLIGENCE_DATA_DIR);
  } catch {
    return [];
  }

  const files: Array<{ absolutePath: string; output: ExtractionOutput }> = [];
  for (const filename of filenames.sort()) {
    if (!/^extractions(?:-\d+d)?-\d{4}-\d{2}-\d{2}\.json$/.test(filename)) {
      continue;
    }
    const absolutePath = path.join(INTELLIGENCE_DATA_DIR, filename);
    try {
      files.push({ absolutePath, output: await readJsonFile<ExtractionOutput>(absolutePath) });
    } catch {
      // A corrupt/partial prior file simply doesn't qualify.
    }
  }
  return files;
}

async function loadPriorExtractionOutputs(): Promise<ExtractionOutput[]> {
  let filenames: string[];
  try {
    filenames = await fs.readdir(INTELLIGENCE_DATA_DIR);
  } catch {
    return [];
  }

  const outputs: ExtractionOutput[] = [];
  for (const filename of filenames) {
    if (!/^extractions(?:-\d+d)?-\d{4}-\d{2}-\d{2}\.json$/.test(filename)) {
      continue;
    }
    try {
      outputs.push(await readJsonFile<ExtractionOutput>(path.join(INTELLIGENCE_DATA_DIR, filename)));
    } catch {
      // A corrupt/partial prior file shouldn't block a new run — it simply
      // won't contribute to the resumability index.
    }
  }
  return outputs;
}

function printProgress(event: ProgressEvent): void {
  console.log(`[${event.index}/${event.total}] analysing thread ${event.rootTs}...`);
  if (event.outcome === "failed") {
    console.log(`✗ failed: ${event.errorMessage ?? "unknown error"}`);
  } else {
    const suffix =
      event.outcome === "cached" ? " (cached)" : event.isTechnicalEscalation === false ? " (not technical)" : "";
    console.log(`✓ ${event.classification}${suffix}`);
    for (const diagnostic of event.normalizations ?? []) {
      console.log(`  ⚠ normalized ${describeNormalization(diagnostic)}`);
    }
  }
  console.log("");
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
    args = parseExtractArgs(process.argv.slice(2));
  } catch (err) {
    fail(`✗ ${err instanceof Error ? err.message : String(err)}`);
  }

  let resolvedInput;
  try {
    resolvedInput = await resolveInputFile({
      explicitInput: args.input,
      defaultDir: SLACK_DATA_DIR,
      prefix: "escalations",
      missingHint:
        "Run `npm run slack:fetch -- --days=90` first, or pass --input=data/slack/escalations-90d-YYYY-MM-DD.json.",
    });
  } catch (err) {
    if (err instanceof InputResolutionError) {
      fail(`✗ ${err.message}`);
    }
    throw err;
  }

  let fetchFile: FetchFile;
  try {
    fetchFile = await readJsonFile<FetchFile>(resolvedInput.absolutePath);
    if (!Array.isArray(fetchFile.threads)) {
      throw new Error("missing or invalid `threads` array");
    }
  } catch (err) {
    fail(`✗ Failed to read input file ${resolvedInput.relativePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const relativeInputPath = resolvedInput.relativePath;

  // --retry-failed re-analyses ONLY the threads whose prior extraction failed,
  // then rewrites that same file in place. Successes are never re-sent.
  let retryTarget: { absolutePath: string; output: ExtractionOutput } | undefined;
  if (args.retryFailed) {
    const priorFiles = await loadPriorExtractionFiles();
    const matching = priorFiles.filter((file) => file.output.metadata.inputFile === relativeInputPath);
    retryTarget = matching.at(-1);
    if (!retryTarget) {
      fail(
        `✗ --retry-failed found no existing extraction output for ${relativeInputPath}.\n` +
          "  Run the extraction normally first, or pass --input matching the original run.",
      );
    }
  }

  const failedRootTs = retryTarget ? failedRootTsValues(retryTarget.output.results) : [];
  const failedSet = new Set(failedRootTs);

  const targets = retryTarget
    ? fetchFile.threads.filter((thread) => failedSet.has(thread.rootTs))
    : computeExtractionTargets(fetchFile.threads, args.limit);
  const sourceWindowDays = fetchFile.metadata.daysBack;
  // Prefer the tag already on the filename; fall back to the fetch metadata
  // so legacy untagged inputs still produce a clearly-labelled output.
  const windowTag =
    resolvedInput.windowTag ?? (typeof sourceWindowDays === "number" ? windowTagForDays(sourceWindowDays) : null);

  console.log(`Escalation Intelligence — LLM Extraction${args.dryRun ? " (dry run)" : ""}`);
  console.log("");
  console.log("Input");
  for (const line of describeInputSelection(resolvedInput)) {
    console.log(line);
  }
  console.log(`✓ ${fetchFile.threads.length} threads available`);
  if (retryTarget) {
    console.log("");
    console.log("Retry");
    console.log(`✓ existing output: ${path.relative(process.cwd(), retryTarget.absolutePath)}`);
    console.log(`✓ ${retryTarget.output.results.length} prior results`);
    console.log(
      `✓ ${retryTarget.output.results.filter((r) => r.status === "success").length} successes preserved (not re-sent to Claude)`,
    );
    console.log(`✓ ${failedRootTs.length} failed records to retry`);
    for (const result of retryTarget.output.results.filter((r) => r.status === "failed")) {
      const fields = describeFailedEnumFields(result.error);
      console.log(`    ${result.rootTs} — ${fields.length > 0 ? `invalid enum: ${fields.join(", ")}` : "non-enum failure"}`);
    }
    if (targets.length !== failedRootTs.length) {
      console.log(`⚠ ${failedRootTs.length - targets.length} failed rootTs values are absent from the input file`);
    }
    if (failedRootTs.length === 0) {
      console.log("");
      console.log("Nothing to retry — every prior record succeeded.");
      console.log("✓ Zero Anthropic API calls made");
      return;
    }
  }
  console.log("");

  if (args.dryRun) {
    const stats = estimateDryRunStats(targets);
    console.log("Plan");
    console.log(`- threads that would be analysed: ${stats.threadCount}`);
    console.log(`- model: ${env.ANTHROPIC_MODEL}`);
    console.log(`- prompt version: ${ESCALATION_EXTRACTION_PROMPT_VERSION}`);
    console.log(`- output file: ${path.relative(process.cwd(), extractionOutputFilePath(INTELLIGENCE_DATA_DIR, new Date(), windowTag))}`);
    console.log("");
    console.log("Estimated payload");
    console.log(`- total cleaned text: ${stats.totalCombinedChars} characters`);
    console.log(`- average per thread: ${stats.averageCharsPerThread} characters`);
    console.log(`- approx. total input tokens: ~${stats.approxTotalInputTokens} (rough estimate, not a real token count)`);
    console.log("");
    console.log("Safety");
    console.log("✓ Zero Anthropic API calls made");
    console.log("✓ No analysis output written");
    return;
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
  const parseFn = createAnthropicParseFn(client);

  const priorOutputs = await loadPriorExtractionOutputs();
  const priorResultsIndex = buildPriorResultsIndex(priorOutputs);

  const freshResults = await analyzeThreads({
    threads: targets,
    parseFn,
    model: env.ANTHROPIC_MODEL,
    promptVersion: ESCALATION_EXTRACTION_PROMPT_VERSION,
    priorResultsIndex,
    onProgress: printProgress,
  });

  // On a retry, the repaired records replace their failed predecessors in
  // place; every other prior result is carried through untouched.
  const results = retryTarget ? mergeRepairedResults(retryTarget.output.results, freshResults) : freshResults;

  const analysedAt = new Date();
  const metadata = buildExtractionMetadata({
    inputFile: relativeInputPath,
    analysedAt,
    promptVersion: ESCALATION_EXTRACTION_PROMPT_VERSION,
    promptRevision: ESCALATION_EXTRACTION_PROMPT_REVISION,
    model: env.ANTHROPIC_MODEL,
    threadsAvailable: fetchFile.threads.length,
    results,
  });
  if (typeof sourceWindowDays === "number") {
    metadata.sourceWindowDays = sourceWindowDays;
  }

  const outputFilePath = retryTarget
    ? retryTarget.absolutePath
    : extractionOutputFilePath(INTELLIGENCE_DATA_DIR, analysedAt, windowTag);
  await writeExtractionOutput({ metadata, results }, outputFilePath);

  const successful = results.filter((result) => result.status === "success").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const breakdown = computeWorkflowBreakdown(results);

  console.log("");
  console.log("Analysed");
  console.log(`✓ ${metadata.threadsAnalysed} threads`);
  console.log("");
  console.log("Classification");
  console.log(`✓ ${breakdown.technical} technical escalations`);
  console.log(`✓ ${breakdown.nonTechnical} non-technical`);
  console.log("");
  console.log("Workflow intelligence");
  console.log(`✓ ${breakdown.workflowCandidates} automation workflow candidates`);
  console.log(`✓ ${breakdown.nonWorkflow} non-workflow threads`);
  console.log(`✓ ${breakdown.technicalAndWorkflow} technical + workflow`);
  console.log(`✓ ${breakdown.workflowOnly} workflow-only`);
  console.log(`✓ ${breakdown.technicalOnly} technical-only`);
  console.log(`✓ ${breakdown.neither} neither`);
  console.log(`  (buckets cover the ${breakdown.analysed} successful extractions; ${breakdown.failed} failed)`);
  console.log("");
  console.log("Workflow types");
  const workflowTypes = countWorkflowClassifications(results);
  const typeWidth = Math.max(...Object.keys(workflowTypes).map((key) => key.length));
  for (const [type, count] of Object.entries(workflowTypes)) {
    console.log(`  ${type.padEnd(typeWidth)}  ${count}`);
  }
  console.log("");
  console.log("Extraction");
  console.log(`✓ ${successful} successful`);
  console.log(`✓ ${failed} failed`);
  const normalized = results.filter((result) => (result.normalizations?.length ?? 0) > 0);
  if (normalized.length > 0) {
    console.log(`⚠ ${normalized.length} results had an invalid enum value rewritten onto a documented fallback`);
    for (const result of normalized) {
      for (const diagnostic of result.normalizations ?? []) {
        console.log(`    ${result.rootTs} — ${describeNormalization(diagnostic)}`);
      }
    }
  }
  if (failed > 0) {
    for (const result of results.filter((r) => r.status === "failed")) {
      const fields = describeFailedEnumFields(result.error);
      console.log(`    ${result.rootTs} — ${fields.length > 0 ? `invalid enum: ${fields.join(", ")}` : "non-enum failure"}`);
    }
    console.log("  Retry just these with: npm run intelligence:extract -- --input=<input> --retry-failed");
  }
  console.log("");
  console.log("Output");
  console.log(`✓ ${path.relative(process.cwd(), outputFilePath)}`);
  console.log("");
  console.log("No Slack messages were posted.");
}

main().catch((err: unknown) => {
  fail(`✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});
