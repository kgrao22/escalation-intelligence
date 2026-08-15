import fs from "node:fs/promises";
import path from "node:path";
import { windowTagForDays } from "../persistence/datedFiles.js";
import type { ExtractionOutput } from "../persistence/extractionOutput.js";
import { describeInputSelection, InputResolutionError, resolveInputFile } from "../persistence/resolveInput.js";
import type { WorkflowAdjudicationOutput } from "../persistence/workflowAdjudicationOutput.js";
import {
  workflowClusterOutputFilePath,
  writeWorkflowClusterOutput,
  type WorkflowClusterOutput,
} from "../persistence/workflowClusterOutput.js";
import {
  buildWorkflowClusters,
  WorkflowClusterIntegrityError,
} from "../workflow/buildWorkflowClusters.js";
import { selectWorkflowEmbeddingCandidates } from "../workflow/workflowEmbeddingCandidates.js";
import { parseWorkflowClustersArgs } from "./workflowClustersArgs.js";

const INTELLIGENCE_DATA_DIR = path.resolve(process.cwd(), "data", "intelligence");

function fail(message: string): never {
  console.error(message);
  console.log("");
  console.log("Workflow clustering failed.");
  process.exit(1);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

function formatBreakdown(breakdown: Record<string, number>): string {
  const entries = Object.entries(breakdown);
  return entries.length === 0 ? "—" : entries.map(([key, count]) => `${key} ${count}`).join(", ");
}

async function main() {
  let args;
  try {
    args = parseWorkflowClustersArgs(process.argv.slice(2));
  } catch (err) {
    fail(`✗ ${err instanceof Error ? err.message : String(err)}`);
  }

  let extractionsInput;
  let adjudicationsInput;
  try {
    extractionsInput = await resolveInputFile({
      explicitInput: args.extractions,
      defaultDir: INTELLIGENCE_DATA_DIR,
      prefix: "extractions",
      missingHint: "Run `npm run intelligence:extract` first, or pass --extractions=<path>.",
    });
    adjudicationsInput = await resolveInputFile({
      explicitInput: args.adjudications,
      defaultDir: INTELLIGENCE_DATA_DIR,
      prefix: "workflow-adjudications",
      missingHint: "Run `npm run intelligence:workflow-adjudicate` first, or pass --adjudications=<path>.",
    });
  } catch (err) {
    if (err instanceof InputResolutionError) {
      fail(`✗ ${err.message}`);
    }
    throw err;
  }

  let extraction: ExtractionOutput;
  let adjudication: WorkflowAdjudicationOutput;
  try {
    extraction = await readJsonFile<ExtractionOutput>(extractionsInput.absolutePath);
    adjudication = await readJsonFile<WorkflowAdjudicationOutput>(adjudicationsInput.absolutePath);
    if (!Array.isArray(extraction.results) || !Array.isArray(adjudication.results)) {
      throw new Error("missing or invalid `results` array");
    }
  } catch (err) {
    fail(`✗ Failed to read input files: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (adjudication.metadata?.category !== "workflow") {
    fail(
      `✗ ${adjudicationsInput.relativePath} is not a workflow adjudication file ` +
        `(category: ${String(adjudication.metadata?.category)}). Refusing to cluster technical verdicts here.`,
    );
  }

  const candidates = selectWorkflowEmbeddingCandidates(extraction);
  if (candidates.length === 0) {
    fail(`✗ ${extractionsInput.relativePath} contains no workflow candidates.`);
  }

  let result;
  try {
    result = buildWorkflowClusters(candidates, adjudication.results);
  } catch (err) {
    if (err instanceof WorkflowClusterIntegrityError) {
      fail(`✗ ${err.message}\n  No output was written.`);
    }
    throw err;
  }

  const { clusters, stats } = result;

  console.log("Workflow clustering");
  console.log("");
  console.log("Input");
  for (const line of describeInputSelection(extractionsInput)) {
    console.log(line);
  }
  for (const line of describeInputSelection(adjudicationsInput)) {
    console.log(line);
  }
  console.log("");

  console.log(`✓ ${stats.totalWorkflowCandidates} workflow candidates`);
  console.log(`✓ ${stats.adjudicatedPairs} adjudicated candidate pairs`);
  console.log(`✓ ${stats.sameEdges} SAME edges`);
  console.log(`✓ ${stats.recurringClusters} recurring clusters`);
  console.log(`✓ ${stats.singletonClusters} singleton workflows`);
  console.log(`✓ largest cluster: ${stats.largestClusterSize} occurrences`);
  console.log("");
  console.log(`  ${stats.relatedEdges} RELATED edges kept as cross-cluster links (never merged)`);
  console.log(`  ${stats.differentEdges} DIFFERENT edges ignored for merging`);
  if (stats.danglingSameEdges > 0) {
    console.log(`⚠ ${stats.danglingSameEdges} SAME edges reference threads absent from the candidate set`);
  }
  console.log("");

  console.log("Integrity");
  console.log(`✓ every candidate appears in exactly one cluster (${stats.totalWorkflowCandidates})`);
  console.log("✓ no rootTs appears in more than one cluster");
  console.log("");

  const recurring = clusters.filter((cluster) => cluster.occurrenceCount > 1);
  console.log(`Top recurring workflows (showing ${Math.min(args.top, recurring.length)} of ${recurring.length})`);
  console.log("");
  recurring.slice(0, args.top).forEach((cluster, index) => {
    console.log(
      `${index + 1}. [${cluster.dominantWorkflowClassification ?? "unclassified"}] — ${cluster.occurrenceCount} occurrences`,
    );
    console.log(`   ${cluster.representativeWorkflowStatement}`);
    console.log(`   automation: ${formatBreakdown(cluster.automationStatusBreakdown)}`);
    console.log(
      `   nature:     technical+workflow ${cluster.technicalWorkflowCount}, workflow-only ${cluster.workflowOnlyCount}`,
    );
    if (cluster.workflowClassifications.length > 1) {
      console.log(`   spans:      ${cluster.workflowClassifications.join(", ")}`);
    }
    console.log(
      `   window:     ${cluster.firstSeen?.slice(0, 10) ?? "?"} → ${cluster.lastSeen?.slice(0, 10) ?? "?"}`,
    );
    if (cluster.relatedClusterIds.length > 0) {
      console.log(`   related:    ${cluster.relatedClusterIds.join(", ")}`);
    }
    console.log(`   cluster id: ${cluster.clusterId}`);
    console.log("");
  });

  if (args.dryRun) {
    console.log("Safety");
    console.log("✓ Zero API calls made");
    console.log("✓ No output file written");
    return;
  }

  const generatedAt = new Date();
  const windowTag =
    adjudicationsInput.windowTag ??
    extractionsInput.windowTag ??
    (typeof adjudication.metadata.sourceWindowDays === "number"
      ? windowTagForDays(adjudication.metadata.sourceWindowDays)
      : null);

  const output: WorkflowClusterOutput = {
    metadata: {
      extractionsInputFile: extractionsInput.relativePath,
      adjudicationsInputFile: adjudicationsInput.relativePath,
      generatedAt: generatedAt.toISOString(),
      ...(typeof adjudication.metadata.sourceWindowDays === "number"
        ? { sourceWindowDays: adjudication.metadata.sourceWindowDays }
        : {}),
      clusteringAlgorithm: "connected_components_over_same_underlying_workflow_edges",
      clusterIdScheme: "wf-<lexicographically-smallest-member-rootTs>",
      totalWorkflowCandidates: stats.totalWorkflowCandidates,
      totalClusters: stats.totalClusters,
      recurringClusters: stats.recurringClusters,
      singletonClusters: stats.singletonClusters,
      largestClusterSize: stats.largestClusterSize,
      sameEdges: stats.sameEdges,
      relatedEdges: stats.relatedEdges,
      differentEdges: stats.differentEdges,
      danglingSameEdges: stats.danglingSameEdges,
      adjudicationModel: adjudication.metadata.model,
      adjudicationPromptVersion: adjudication.metadata.promptVersion,
      category: "workflow",
    },
    clusters,
  };

  const outputFilePath = workflowClusterOutputFilePath(INTELLIGENCE_DATA_DIR, generatedAt, windowTag);
  await writeWorkflowClusterOutput(output, outputFilePath);

  console.log("Output");
  console.log(`✓ ${path.relative(process.cwd(), outputFilePath)}`);
  console.log("");
  console.log("No API calls were made.");
  console.log("Nothing was posted to Slack.");
}

main().catch((err: unknown) => {
  fail(`✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});
