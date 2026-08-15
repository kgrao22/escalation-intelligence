import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import type { ReviewArtifact } from "../persistence/reviewArtifactOutput.js";
import { reviewPreviewFilePath, writeReviewPreview } from "../persistence/reviewPreviewOutput.js";
import { describeInputSelection, InputResolutionError, resolveInputFile } from "../persistence/resolveInput.js";
import { buildReviewPreview } from "../reviewPublishing/buildReviewPreview.js";
import { UnsupportedClaimError } from "../reviewPublishing/slackSafeCopy.js";

const INTELLIGENCE_DATA_DIR = path.resolve(process.cwd(), "data", "intelligence");

function fail(message: string): never {
  console.error(message);
  console.log("");
  console.log("Review Slack preview failed.");
  process.exit(1);
}

async function main() {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { input: { type: "string" } }, strict: false });

  let resolvedInput;
  try {
    resolvedInput = await resolveInputFile({
      explicitInput: values.input === undefined ? undefined : String(values.input),
      defaultDir: INTELLIGENCE_DATA_DIR,
      prefix: "review",
      missingHint: "Run `npm run intelligence:review` first, or pass --input=<path>.",
    });
  } catch (err) {
    if (err instanceof InputResolutionError) {
      fail(`✗ ${err.message}`);
    }
    throw err;
  }

  let review: ReviewArtifact;
  try {
    review = JSON.parse(await fs.readFile(resolvedInput.absolutePath, "utf8")) as ReviewArtifact;
    if (!Array.isArray(review.automationOpportunities)) {
      throw new Error("missing or invalid `automationOpportunities`");
    }
  } catch (err) {
    fail(`✗ Failed to read ${resolvedInput.relativePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const generatedAt = new Date();
  let preview;
  try {
    preview = buildReviewPreview(review, resolvedInput.relativePath, generatedAt);
  } catch (err) {
    if (err instanceof UnsupportedClaimError) {
      fail(`✗ ${err.message}\n  No preview was written.`);
    }
    throw err;
  }

  console.log("Escalation Intelligence — Review Slack Preview");
  console.log("");
  console.log("Input");
  for (const line of describeInputSelection(resolvedInput)) {
    console.log(line);
  }
  console.log(`✓ destination (encoded in preview): ${preview.metadata.destinationChannelId}`);
  console.log(`✓ ${preview.metadata.messageCount} messages: 1 parent + ${preview.metadata.messageCount - 1} thread replies`);
  console.log("");

  for (const message of preview.messages) {
    console.log("─".repeat(72));
    console.log(`${message.kind === "parent" ? "TOP-LEVEL MESSAGE" : `THREAD REPLY ${message.index - 1}`}: ${message.title}`);
    console.log("─".repeat(72));
    console.log(message.text);
    console.log("");
  }

  const outputFilePath = reviewPreviewFilePath(INTELLIGENCE_DATA_DIR, generatedAt, review.metadata.windowTag);
  await writeReviewPreview(preview, outputFilePath);

  console.log("Output");
  console.log(`✓ ${path.relative(process.cwd(), outputFilePath)}`);
  console.log("");
  console.log("Safety");
  console.log("✓ Zero Slack API calls made");
  console.log("✓ Nothing was posted");
  console.log("✓ Slack copy contains no unsupported time, rate, or financial claims");
}

main().catch((err: unknown) => {
  fail(`✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});
