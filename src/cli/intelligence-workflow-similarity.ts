import fs from "node:fs/promises";
import path from "node:path";
import { parseWorkflowSimilarityArgs } from "./workflowSimilarityArgs.js";
import { expectedUniquePairCount } from "../embeddings/similarityStats.js";
import { describeInputSelection, InputResolutionError, resolveInputFile } from "../persistence/resolveInput.js";
import type { WorkflowEmbeddingOutput } from "../persistence/workflowEmbeddingOutput.js";
import {
  computeWorkflowBuckets,
  computeWorkflowPairs,
  splitByClassification,
  summarizeWorkflowSimilarity,
  type WorkflowSimilarityBucket,
} from "../workflow/workflowSimilarity.js";

const INTELLIGENCE_DATA_DIR = path.resolve(process.cwd(), "data", "intelligence");

function fail(message: string): never {
  console.error(message);
  console.log("");
  console.log("Workflow similarity report failed.");
  process.exit(1);
}

function printBuckets(buckets: WorkflowSimilarityBucket[], total: number, indent = "  "): void {
  const width = Math.max(...buckets.map((bucket) => bucket.label.length));
  for (const bucket of buckets) {
    const share = total === 0 ? 0 : (bucket.count / total) * 100;
    console.log(
      `${indent}${bucket.label.padEnd(width)}  ${String(bucket.count).padStart(7)}  ${share.toFixed(1).padStart(5)}%`,
    );
  }
}

async function main() {
  let args;
  try {
    args = parseWorkflowSimilarityArgs(process.argv.slice(2));
  } catch (err) {
    fail(`✗ ${err instanceof Error ? err.message : String(err)}`);
  }

  let resolvedInput;
  try {
    resolvedInput = await resolveInputFile({
      explicitInput: args.input,
      defaultDir: INTELLIGENCE_DATA_DIR,
      prefix: "workflow-embeddings",
      missingHint: "Run `npm run intelligence:workflow-embed` first, or pass --input=<path>.",
    });
  } catch (err) {
    if (err instanceof InputResolutionError) {
      fail(`✗ ${err.message}`);
    }
    throw err;
  }

  let output: WorkflowEmbeddingOutput;
  try {
    output = JSON.parse(await fs.readFile(resolvedInput.absolutePath, "utf8")) as WorkflowEmbeddingOutput;
    if (!Array.isArray(output.embeddings)) {
      throw new Error("missing or invalid `embeddings` array");
    }
  } catch (err) {
    fail(`✗ Failed to read ${resolvedInput.relativePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (output.metadata?.embeddedField !== "normalizedWorkflowStatement") {
    fail(
      `✗ ${resolvedInput.relativePath} is not a workflow embedding file ` +
        `(embeddedField: ${String(output.metadata?.embeddedField)}). Refusing to analyse technical vectors here.`,
    );
  }

  const entries = output.embeddings;
  if (entries.length < 2) {
    fail(`✗ Need at least 2 workflow embeddings to form pairs; found ${entries.length}.`);
  }

  const pairs = computeWorkflowPairs(entries);
  const similarities = pairs.map((pair) => pair.similarity);
  const summary = summarizeWorkflowSimilarity(entries.length, similarities);
  const buckets = computeWorkflowBuckets(similarities);
  const split = splitByClassification(pairs);

  console.log("Escalation Intelligence — Workflow Similarity (local analysis)");
  console.log("");
  console.log("Input");
  for (const line of describeInputSelection(resolvedInput)) {
    console.log(line);
  }
  console.log(`✓ embedded field: ${output.metadata.embeddedField}`);
  console.log(`✓ embedding model: ${output.metadata.embeddingModel}`);
  console.log("");

  console.log("Summary");
  console.log(`✓ ${summary.totalEmbeddings} workflow embeddings`);
  console.log(`✓ ${summary.totalPairs} unique pairs (expected ${expectedUniquePairCount(entries.length)})`);
  console.log(`✓ max similarity:    ${summary.max.toFixed(4)}`);
  console.log(`✓ median similarity: ${summary.median.toFixed(4)}`);
  console.log(`✓ mean similarity:   ${summary.mean.toFixed(4)}`);
  console.log("");

  console.log("Distribution");
  printBuckets(buckets, summary.totalPairs);
  console.log("");
  console.log("  These are observation buckets only. No threshold has been chosen —");
  console.log("  a workflow recurrence floor is deliberately NOT set in this milestone.");
  console.log("");

  console.log("Same vs cross workflowClassification");
  console.log(`  same-classification pairs:  ${split.same.totalPairs}`);
  if (split.same.totalPairs > 0) {
    console.log(`    max ${split.same.max.toFixed(4)} | median ${split.same.median.toFixed(4)} | mean ${split.same.mean.toFixed(4)}`);
    printBuckets(split.same.buckets, split.same.totalPairs, "    ");
  }
  console.log(`  cross-classification pairs: ${split.cross.totalPairs}`);
  if (split.cross.totalPairs > 0) {
    console.log(`    max ${split.cross.max.toFixed(4)} | median ${split.cross.median.toFixed(4)} | mean ${split.cross.mean.toFixed(4)}`);
    printBuckets(split.cross.buckets, split.cross.totalPairs, "    ");
  }
  console.log("");
  console.log("  No pair was filtered out. Cross-classification pairs are retained.");
  console.log("");

  console.log(`Top ${Math.min(args.top, pairs.length)} pairs`);
  console.log("");
  pairs.slice(0, args.top).forEach((pair, index) => {
    console.log(`${index + 1}. similarity ${pair.similarity.toFixed(4)}  [${pair.sameClassification ? "same" : "cross"}-classification]`);
    console.log(`   A (${pair.a.workflowClassification ?? "unclassified"} / ${pair.a.automationStatus} / ${pair.a.nature})`);
    console.log(`     ${pair.a.statement}`);
    console.log(`     ${pair.a.permalink ?? "(no permalink)"}`);
    console.log(`   B (${pair.b.workflowClassification ?? "unclassified"} / ${pair.b.automationStatus} / ${pair.b.nature})`);
    console.log(`     ${pair.b.statement}`);
    console.log(`     ${pair.b.permalink ?? "(no permalink)"}`);
    console.log("");
  });

  console.log("No API calls were made.");
  console.log("Nothing was posted to Slack.");
}

main().catch((err: unknown) => {
  fail(`✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});
