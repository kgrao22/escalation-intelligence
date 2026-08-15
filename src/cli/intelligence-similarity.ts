import fs from "node:fs/promises";
import path from "node:path";
import {
  computeAllPairs,
  computeNearestNeighbours,
  DEFAULT_NEIGHBOUR_COUNT,
  DEFAULT_TOP_PAIR_COUNT,
} from "../embeddings/nearestNeighbours.js";
import {
  computeSimilarityBuckets,
  computeSimilarityStats,
  expectedUniquePairCount,
} from "../embeddings/similarityStats.js";
import type { EmbeddingOutput } from "../persistence/embeddingOutput.js";
import { describeInputSelection, InputResolutionError, resolveInputFile } from "../persistence/resolveInput.js";
import { parseSimilarityArgs } from "./similarityArgs.js";

const INTELLIGENCE_DATA_DIR = path.resolve(process.cwd(), "data", "intelligence");

function fail(message: string): never {
  console.error(message);
  console.log("");
  console.log("Similarity report failed.");
  process.exit(1);
}

function formatSimilarity(value: number): string {
  return value.toFixed(2);
}

async function main() {
  const args = parseSimilarityArgs(process.argv.slice(2));

  let resolvedInput;
  try {
    resolvedInput = await resolveInputFile({
      explicitInput: args.input,
      defaultDir: INTELLIGENCE_DATA_DIR,
      prefix: "embeddings",
      missingHint:
        "Run `npm run intelligence:embed` first, or pass --input=data/intelligence/embeddings-90d-YYYY-MM-DD.json.",
    });
  } catch (err) {
    if (err instanceof InputResolutionError) {
      fail(`✗ ${err.message}`);
    }
    throw err;
  }

  let output: EmbeddingOutput;
  try {
    output = JSON.parse(await fs.readFile(resolvedInput.absolutePath, "utf8")) as EmbeddingOutput;
  } catch (err) {
    fail(`✗ Failed to read ${resolvedInput.relativePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const entries = output.embeddings;
  if (entries.length < 2) {
    fail(`✗ Need at least 2 embeddings to compare; ${resolvedInput.relativePath} has ${entries.length}.`);
  }

  const pairs = computeAllPairs(entries);
  const similarities = pairs.map((pair) => pair.similarity);
  const stats = computeSimilarityStats(entries.length, similarities);

  console.log("Escalation Intelligence — Semantic Similarity Report");
  console.log("");
  console.log("Input");
  for (const line of describeInputSelection(resolvedInput)) {
    console.log(line);
  }
  console.log(`✓ model: ${output.metadata.embeddingModel} (${output.metadata.embeddingDimension} dimensions)`);
  if (typeof output.metadata.sourceWindowDays === "number") {
    console.log(`✓ source window: ${output.metadata.sourceWindowDays} days`);
  }
  console.log("");
  console.log("These are raw cosine similarities for manual inspection. No threshold");
  console.log("has been chosen and nothing here asserts that two items are the same issue.");
  console.log("");

  console.log("=".repeat(72));
  console.log("Summary");
  console.log("=".repeat(72));
  console.log("");
  console.log(`Total technical escalations: ${stats.totalItems}`);
  console.log(`Total unique pairs:          ${stats.totalPairs}`);
  console.log(`Maximum similarity:          ${stats.max.toFixed(4)}`);
  console.log(`Median similarity:           ${stats.median.toFixed(4)}`);
  console.log(`Mean similarity:             ${stats.mean.toFixed(4)}`);
  console.log("");

  console.log("=".repeat(72));
  console.log("Similarity distribution (observation buckets only)");
  console.log("=".repeat(72));
  console.log("");
  console.log("No bucket means \"same issue\". These describe the shape of the data so");
  console.log("a human can judge where meaningful recurrence might begin.");
  console.log("");

  for (const bucket of computeSimilarityBuckets(similarities)) {
    const share = stats.totalPairs === 0 ? 0 : (bucket.count / stats.totalPairs) * 100;
    console.log(`  ${bucket.label.padEnd(16)} ${String(bucket.count).padStart(6)}  (${share.toFixed(1)}%)`);
  }
  console.log("");

  console.log("=".repeat(72));
  console.log(`Nearest neighbours (top ${DEFAULT_NEIGHBOUR_COUNT} per escalation)`);
  console.log("=".repeat(72));
  console.log("");

  for (const report of computeNearestNeighbours(entries, DEFAULT_NEIGHBOUR_COUNT)) {
    console.log("Issue:");
    console.log(`"${report.normalizedProblemStatement}"`);
    console.log("");
    console.log("Nearest issues:");
    console.log("");
    report.neighbours.forEach((neighbour, index) => {
      console.log(`${index + 1}. similarity: ${formatSimilarity(neighbour.similarity)}`);
      console.log(`   "${neighbour.normalizedProblemStatement}"`);
      console.log("");
    });
    console.log("-".repeat(72));
    console.log("");
  }

  console.log("=".repeat(72));
  console.log(`Top ${DEFAULT_TOP_PAIR_COUNT} semantic pairs (unique, across the whole dataset)`);
  console.log("=".repeat(72));
  console.log("");

  pairs.slice(0, DEFAULT_TOP_PAIR_COUNT).forEach((pair, index) => {
    console.log(`${index + 1}. ${formatSimilarity(pair.similarity)}`);
    console.log(`   A: "${pair.a.normalizedProblemStatement}"`);
    console.log(`      rootTs:    ${pair.a.rootTs}`);
    console.log(`      permalink: ${pair.a.permalink ?? "(none)"}`);
    console.log(`   B: "${pair.b.normalizedProblemStatement}"`);
    console.log(`      rootTs:    ${pair.b.rootTs}`);
    console.log(`      permalink: ${pair.b.permalink ?? "(none)"}`);
    console.log("");
  });

  if (stats.totalPairs !== expectedUniquePairCount(entries.length)) {
    console.log(
      `⚠ Pair count ${stats.totalPairs} does not match the expected ${expectedUniquePairCount(entries.length)} for ${entries.length} items.`,
    );
    console.log("");
  }

  console.log("Report complete. No API calls were made — this is computed locally.");
}

main().catch((err: unknown) => {
  fail(`✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});
