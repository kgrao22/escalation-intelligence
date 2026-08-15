import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import fs from "node:fs/promises";
import path from "node:path";
import { EnvValidationError, requireAnthropicApiKey } from "../config/env.js";
import { getEnv } from "../config/loadEnv.js";
import {
  WORKFLOW_RECOMMENDATION_PROMPT_VERSION,
} from "../llm/prompts/workflowRecommendation.js";
import { WorkflowRecommendationLLMOutputSchema } from "../llm/schemas/workflowRecommendation.js";
import { createStructuredParseFn, type ParseableOutputFormat } from "../llm/structuredParse.js";
import { windowTagForDays } from "../persistence/datedFiles.js";
import type { ExtractionOutput } from "../persistence/extractionOutput.js";
import { describeInputSelection, InputResolutionError, resolveInputFile } from "../persistence/resolveInput.js";
import type { WorkflowClusterOutput } from "../persistence/workflowClusterOutput.js";
import {
  workflowRecommendationOutputFilePath,
  writeWorkflowRecommendationOutput,
  type LongTailSummary,
  type WorkflowRecommendationOutput,
} from "../persistence/workflowRecommendationOutput.js";
import {
  buildClusterEvidence,
  runWorkflowRecommendation,
  type WorkflowRecommendationProgressEvent,
} from "../workflow/runWorkflowRecommendation.js";
import {
  buildCustomerImpactIndex,
  MIN_OCCURRENCES_FOR_RANKING,
  rankClusters,
  SCORING_FORMULA,
  SCORING_WEIGHTS,
} from "../workflow/workflowScoring.js";
import { parseWorkflowRecommendArgs } from "./workflowRecommendArgs.js";

const INTELLIGENCE_DATA_DIR = path.resolve(process.cwd(), "data", "intelligence");

/** A short structured recommendation, not an essay. */
const MAX_OUTPUT_TOKENS = 1536;

function fail(message: string): never {
  console.error(message);
  console.log("");
  console.log("Workflow recommendation failed.");
  process.exit(1);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  return entries.length === 0 ? "—" : entries.map(([key, value]) => `${key} ${value}`).join(", ");
}

function printProgress(event: WorkflowRecommendationProgressEvent): void {
  const prefix = `[${event.index}/${event.total}] ${event.clusterId}`;
  console.log(
    event.outcome === "failed"
      ? `${prefix} → ✗ ${event.errorMessage ?? "unknown error"}`
      : `${prefix} → ${event.recommendedAction}`,
  );
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
    args = parseWorkflowRecommendArgs(process.argv.slice(2));
  } catch (err) {
    fail(`✗ ${err instanceof Error ? err.message : String(err)}`);
  }

  let clustersInput;
  try {
    clustersInput = await resolveInputFile({
      explicitInput: args.input,
      defaultDir: INTELLIGENCE_DATA_DIR,
      prefix: "workflow-clusters",
      missingHint: "Run `npm run intelligence:workflow-clusters` first, or pass --input=<path>.",
    });
  } catch (err) {
    if (err instanceof InputResolutionError) {
      fail(`✗ ${err.message}`);
    }
    throw err;
  }

  let clusterOutput: WorkflowClusterOutput;
  try {
    clusterOutput = await readJsonFile<WorkflowClusterOutput>(clustersInput.absolutePath);
    if (!Array.isArray(clusterOutput.clusters)) {
      throw new Error("missing or invalid `clusters` array");
    }
  } catch (err) {
    fail(`✗ Failed to read ${clustersInput.relativePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (clusterOutput.metadata?.category !== "workflow") {
    fail(`✗ ${clustersInput.relativePath} is not a workflow cluster file. Refusing to rank it.`);
  }

  // Extraction evidence is optional but strongly preferred: without it,
  // customer impact is explicitly neutral rather than guessed.
  let extraction: ExtractionOutput | undefined;
  let extractionsInput;
  try {
    extractionsInput = await resolveInputFile({
      explicitInput: args.extractions ?? clusterOutput.metadata.extractionsInputFile,
      defaultDir: INTELLIGENCE_DATA_DIR,
      prefix: "extractions",
      missingHint: "Pass --extractions=<path> to include customer-impact evidence.",
    });
    extraction = await readJsonFile<ExtractionOutput>(extractionsInput.absolutePath);
  } catch {
    extractionsInput = undefined;
    extraction = undefined;
  }

  const asOf = new Date();
  const impactByRootTs = buildCustomerImpactIndex(extraction);
  const evidence = buildClusterEvidence(extraction);
  const rankedAll = rankClusters(clusterOutput.clusters, impactByRootTs, asOf);
  const ranked = args.limit === undefined ? rankedAll : rankedAll.slice(0, args.limit);

  const singletons = clusterOutput.clusters.filter(
    (cluster) => cluster.occurrenceCount < MIN_OCCURRENCES_FOR_RANKING,
  );
  const longTail: LongTailSummary = {
    singletonWorkflowCount: singletons.length,
    byClassification: Object.fromEntries(
      Object.entries(
        singletons.reduce<Record<string, number>>((acc, cluster) => {
          const key = cluster.dominantWorkflowClassification ?? "(unclassified)";
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {}),
      ).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    ),
  };

  console.log(`Escalation Intelligence — Workflow Automation Opportunities${args.dryRun ? " (dry run)" : ""}`);
  console.log("");
  console.log("Input");
  for (const line of describeInputSelection(clustersInput)) {
    console.log(line);
  }
  if (extractionsInput) {
    for (const line of describeInputSelection(extractionsInput)) {
      console.log(line);
    }
  } else {
    console.log("⚠ no extraction file resolved — customer impact scored as neutral, never guessed");
  }
  console.log("");

  console.log("Eligibility");
  console.log(`✓ ${clusterOutput.clusters.length} clusters`);
  console.log(`✓ ${rankedAll.length} recurring clusters eligible (occurrenceCount >= ${MIN_OCCURRENCES_FOR_RANKING})`);
  console.log(`✓ ${longTail.singletonWorkflowCount} singletons excluded from ranking (reported as long tail)`);
  if (args.limit !== undefined) {
    console.log(`✓ limited to ${ranked.length} for this run`);
  }
  console.log("");

  console.log("Deterministic scoring");
  console.log(`  formula: ${SCORING_FORMULA}`);
  console.log(`  weights: ${formatCounts(SCORING_WEIGHTS as unknown as Record<string, number>)}`);
  console.log("");
  for (const [index, scored] of ranked.entries()) {
    const f = scored.scoringBreakdown.factors;
    console.log(
      `${index + 1}. ${scored.cluster.clusterId}  score ${scored.baseScore.toFixed(2)}  (${scored.cluster.occurrenceCount} occurrences)`,
    );
    console.log(
      `   freq ${f.frequency.raw} | burden ${f.manualBurden.raw} | readiness ${f.automationReadiness.raw} | ` +
        `eng ${f.engineeringDependency.raw} | impact ${f.customerImpact.raw} | recency ${f.recency.raw}`,
    );
    console.log(`   ${scored.cluster.representativeWorkflowStatement}`);
    console.log("");
  }

  if (args.dryRun) {
    console.log("Plan");
    console.log(`- model: ${env.ANTHROPIC_MODEL}`);
    console.log(`- prompt version: ${WORKFLOW_RECOMMENDATION_PROMPT_VERSION}`);
    console.log(`- estimated Anthropic calls: ${ranked.length} (one per ranked cluster)`);
    console.log(
      `- output file: ${path.relative(process.cwd(), workflowRecommendationOutputFilePath(INTELLIGENCE_DATA_DIR, new Date(), clustersInput.windowTag))}`,
    );
    console.log("");
    console.log("Safety");
    console.log("✓ Zero Anthropic API calls made");
    console.log("✓ No output file written");
    console.log("✓ Only de-identified cluster statistics and workflow statements would be transmitted —");
    console.log("  no permalinks, no rootTs, no raw Slack text, and no base score or rank");
    return;
  }

  if (ranked.length === 0) {
    fail(`✗ No recurring clusters to rank (need occurrenceCount >= ${MIN_OCCURRENCES_FOR_RANKING}).`);
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
    zodOutputFormat(WorkflowRecommendationLLMOutputSchema) as ParseableOutputFormat<unknown>,
    MAX_OUTPUT_TOKENS,
  );

  console.log("LLM recommendations");
  console.log("");
  const recommendations = await runWorkflowRecommendation({
    scored: ranked,
    evidence,
    parseFn,
    model: env.ANTHROPIC_MODEL,
    onProgress: printProgress,
  });

  const createdAt = new Date();
  const failed = recommendations.filter((item) => item.status === "failed").length;
  const windowTag =
    clustersInput.windowTag ??
    (typeof clusterOutput.metadata.sourceWindowDays === "number"
      ? windowTagForDays(clusterOutput.metadata.sourceWindowDays)
      : null);

  const output: WorkflowRecommendationOutput = {
    metadata: {
      inputFile: clustersInput.relativePath,
      ...(extractionsInput ? { extractionsInputFile: extractionsInput.relativePath } : {}),
      createdAt: createdAt.toISOString(),
      ...(typeof clusterOutput.metadata.sourceWindowDays === "number"
        ? { sourceWindowDays: clusterOutput.metadata.sourceWindowDays }
        : {}),
      model: env.ANTHROPIC_MODEL,
      promptVersion: WORKFLOW_RECOMMENDATION_PROMPT_VERSION,
      scoringFormula: SCORING_FORMULA,
      scoringWeights: SCORING_WEIGHTS as unknown as Record<string, number>,
      minOccurrencesForRanking: MIN_OCCURRENCES_FOR_RANKING,
      totalClusters: clusterOutput.clusters.length,
      rankedClusters: ranked.length,
      recommended: recommendations.length - failed,
      failed,
      category: "workflow",
    },
    recommendations,
    longTail,
  };

  const outputFilePath = workflowRecommendationOutputFilePath(INTELLIGENCE_DATA_DIR, createdAt, windowTag);
  await writeWorkflowRecommendationOutput(output, outputFilePath);

  console.log("");
  console.log("Ranked automation opportunities");
  console.log("");
  for (const item of recommendations) {
    if (item.status === "failed") {
      console.log(`${item.rank}. ${item.clusterId} — ✗ ${item.error ?? "failed"}`);
      continue;
    }
    console.log(
      `${item.rank}. [${item.dominantWorkflowClassification ?? "unclassified"}] score ${item.baseScore.toFixed(2)} — ${item.occurrenceCount} occurrences`,
    );
    console.log(`   ${item.representativeWorkflowStatement}`);
    console.log(
      `   action: ${item.recommendedAction} | priority: ${item.automationPriority} | feasibility: ${item.automationFeasibility}`,
    );
    console.log(`   proposal: ${item.proposedAutomation}`);
    console.log("");
  }

  console.log(`Long tail: ${longTail.singletonWorkflowCount} singleton workflows not ranked`);
  console.log("");
  console.log("Output");
  console.log(`✓ ${path.relative(process.cwd(), outputFilePath)}`);
  console.log("");
  console.log("Only de-identified cluster data was sent to Claude.");
  console.log("No permalink, rootTs, or raw Slack text left this machine.");
  console.log("Nothing was posted to Slack.");
}

main().catch((err: unknown) => {
  fail(`✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});
