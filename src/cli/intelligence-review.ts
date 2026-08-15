import fs from "node:fs/promises";
import path from "node:path";
import { computeAllPairs } from "../embeddings/nearestNeighbours.js";
import { expectedUniquePairCount } from "../embeddings/similarityStats.js";
import { windowTagForDays } from "../persistence/datedFiles.js";
import type { EmbeddingOutput } from "../persistence/embeddingOutput.js";
import { describeInputSelection, InputResolutionError, resolveInputFile } from "../persistence/resolveInput.js";
import {
  REVIEW_INSTRUCTIONS,
  reviewOutputFilePath,
  writeReviewOutput,
  type ReviewOutput,
  type ReviewPair,
} from "../persistence/reviewOutput.js";
import {
  DEFAULT_MAX_PER_BUCKET,
  DEFAULT_TOP_BUCKET_CAP,
  pairKey,
  selectReviewPairs,
} from "../review/selectReviewPairs.js";
import { parseReviewArgs } from "./reviewArgs.js";

const INTELLIGENCE_DATA_DIR = path.resolve(process.cwd(), "data", "intelligence");
const REVIEWS_DIR = path.join(INTELLIGENCE_DATA_DIR, "reviews");

function fail(message: string): never {
  console.error(message);
  console.log("");
  console.log("Review artifact generation failed.");
  process.exit(1);
}

async function main() {
  let args;
  try {
    args = parseReviewArgs(process.argv.slice(2));
  } catch (err) {
    fail(`✗ ${err instanceof Error ? err.message : String(err)}`);
  }

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
    fail(`✗ Need at least 2 embeddings to form review pairs; ${resolvedInput.relativePath} has ${entries.length}.`);
  }

  const maxPerBucket = args.maxPerBucket ?? DEFAULT_MAX_PER_BUCKET;
  const allPairs = computeAllPairs(entries);
  const selection = selectReviewPairs(allPairs, { maxPerBucket, topBucketCap: DEFAULT_TOP_BUCKET_CAP });

  const reviewPairs: ReviewPair[] = selection.pairs.map((pair) => ({
    pairId: pairKey(pair),
    bucket: pair.bucket,
    similarity: pair.similarity,
    a: { rootTs: pair.a.rootTs, normalizedProblemStatement: pair.a.normalizedProblemStatement, permalink: pair.a.permalink },
    b: { rootTs: pair.b.rootTs, normalizedProblemStatement: pair.b.normalizedProblemStatement, permalink: pair.b.permalink },
    sameUnderlyingIssue: null,
    reviewerNotes: "",
  }));

  const createdAt = new Date();
  const windowTag =
    resolvedInput.windowTag ??
    (typeof output.metadata.sourceWindowDays === "number"
      ? windowTagForDays(output.metadata.sourceWindowDays)
      : null);

  const reviewOutput: ReviewOutput = {
    metadata: {
      inputFile: resolvedInput.relativePath,
      createdAt: createdAt.toISOString(),
      embeddingModel: output.metadata.embeddingModel,
      embeddingDimension: output.metadata.embeddingDimension,
      ...(typeof output.metadata.sourceWindowDays === "number"
        ? { sourceWindowDays: output.metadata.sourceWindowDays }
        : {}),
      totalTechnicalEscalations: entries.length,
      totalUniquePairs: allPairs.length,
      reviewPairCount: reviewPairs.length,
      maxPerBucket,
      topBucketCap: DEFAULT_TOP_BUCKET_CAP,
      buckets: selection.buckets,
    },
    instructions: REVIEW_INSTRUCTIONS,
    pairs: reviewPairs,
  };

  const outputFilePath = reviewOutputFilePath(REVIEWS_DIR, createdAt, windowTag);
  await writeReviewOutput(reviewOutput, outputFilePath);

  console.log("Escalation Intelligence — Similarity Review Set");
  console.log("");
  console.log("Input");
  for (const line of describeInputSelection(resolvedInput)) {
    console.log(line);
  }
  console.log(`✓ model: ${output.metadata.embeddingModel} (${output.metadata.embeddingDimension} dimensions)`);
  console.log(`✓ ${entries.length} technical escalations → ${allPairs.length} unique pairs`);
  console.log("");

  console.log("Review pairs by similarity bucket");
  console.log("");
  console.log(`  ${"bucket".padEnd(16)} ${"selected".padStart(8)} ${"available".padStart(10)}`);
  for (const bucket of selection.buckets) {
    console.log(
      `  ${bucket.label.padEnd(16)} ${String(bucket.selected).padStart(8)} ${String(bucket.available).padStart(10)}`,
    );
  }
  console.log("");
  console.log(`  Total selected for review: ${reviewPairs.length}`);
  console.log("");

  console.log("Output");
  console.log(`✓ ${path.relative(process.cwd(), outputFilePath)}`);
  console.log("");
  console.log("Next: label each pair's sameUnderlyingIssue as true / false / \"unsure\".");
  console.log("No threshold has been chosen — these labels are the evidence for choosing one.");
  console.log("");
  console.log("Safety");
  console.log("✓ No Claude, Voyage, or Slack API calls — computed entirely locally");
  console.log("✓ Existing embeddings and extractions were not modified");

  if (allPairs.length !== expectedUniquePairCount(entries.length)) {
    console.log("");
    console.log(
      `⚠ Pair count ${allPairs.length} does not match the expected ${expectedUniquePairCount(entries.length)} for ${entries.length} items.`,
    );
  }
}

main().catch((err: unknown) => {
  fail(`✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});
