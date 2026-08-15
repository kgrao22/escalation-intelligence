import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { EnvValidationError } from "../config/env.js";
import { getEnv } from "../config/loadEnv.js";
import { describeInputSelection, InputResolutionError, resolveInputFile } from "../persistence/resolveInput.js";
import type { ReviewPreviewArtifact } from "../reviewPublishing/buildReviewPreview.js";
import {
  buildPublishedIndex,
  isPublicationComplete,
  resolveParentTs,
  runReviewPublication,
  type PriorReviewPublication,
} from "../reviewPublishing/runReviewPublication.js";
import { createSlackPostFn } from "../slackPublishing/client.js";
import {
  EXPECTED_DESTINATION_CHANNEL_ID,
  FORBIDDEN_SOURCE_CHANNEL_ID,
  PublicationSafetyError,
} from "../slackPublishing/safety.js";

const INTELLIGENCE_DATA_DIR = path.resolve(process.cwd(), "data", "intelligence");
const PUBLICATIONS_DIR = path.join(INTELLIGENCE_DATA_DIR, "publications");

function fail(message: string): never {
  console.error(message);
  console.log("");
  console.log("Review publication failed. Nothing further was posted.");
  process.exit(1);
}

async function loadPriorPublications(): Promise<Array<PriorReviewPublication & { filename: string }>> {
  let filenames: string[];
  try {
    filenames = await fs.readdir(PUBLICATIONS_DIR);
  } catch {
    return [];
  }
  const priors: Array<PriorReviewPublication & { filename: string }> = [];
  for (const filename of filenames.sort()) {
    // Only receipts from THIS publisher; the legacy 90-day format is ignored.
    if (!/^review-slack-publication-.*\.json$/.test(filename)) {
      continue;
    }
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(PUBLICATIONS_DIR, filename), "utf8")) as PriorReviewPublication;
      priors.push({ ...parsed, filename });
    } catch {
      // A corrupt receipt contributes nothing to resume state.
    }
  }
  return priors;
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { input: { type: "string" }, publish: { type: "boolean", default: false } },
    strict: false,
  });
  const publishConfirmed = Boolean(values.publish);

  let resolvedInput;
  try {
    resolvedInput = await resolveInputFile({
      explicitInput: values.input === undefined ? undefined : String(values.input),
      defaultDir: INTELLIGENCE_DATA_DIR,
      prefix: "review-slack-preview",
      missingHint: "Run `npm run intelligence:review-slack-preview` first, or pass --input=<path>.",
    });
  } catch (err) {
    if (err instanceof InputResolutionError) {
      fail(`✗ ${err.message}`);
    }
    throw err;
  }

  let preview: ReviewPreviewArtifact;
  try {
    preview = JSON.parse(await fs.readFile(resolvedInput.absolutePath, "utf8")) as ReviewPreviewArtifact;
  } catch (err) {
    fail(`✗ Failed to read ${resolvedInput.relativePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Refuse anything that is not this publisher's own preview format.
  if (preview.metadata?.previewFormat !== "review-v1") {
    fail(
      `✗ ${resolvedInput.relativePath} is not a review-v1 preview (previewFormat: ${String(preview.metadata?.previewFormat)}).\n` +
        "  This publisher does not consume the legacy 90-day slack-preview format.",
    );
  }
  if (!Array.isArray(preview.messages) || preview.messages.length === 0) {
    fail(`✗ ${resolvedInput.relativePath} contains no messages.`);
  }

  const destination = preview.metadata.destinationChannelId;
  if (destination === FORBIDDEN_SOURCE_CHANNEL_ID) {
    fail(`✗ Preview targets the SOURCE channel ${FORBIDDEN_SOURCE_CHANNEL_ID}. Refusing.`);
  }
  if (destination !== EXPECTED_DESTINATION_CHANNEL_ID) {
    fail(`✗ Preview targets ${destination}; only ${EXPECTED_DESTINATION_CHANNEL_ID} is permitted.`);
  }

  const priors = await loadPriorPublications();
  const published = buildPublishedIndex(priors, resolvedInput.relativePath);
  const parentTs = resolveParentTs(priors, resolvedInput.relativePath, published);
  const complete = isPublicationComplete(preview, published);
  const outstanding = preview.messages.filter((message) => !published.has(message.index));

  console.log(`Escalation Intelligence — Review Publication${publishConfirmed ? " (LIVE)" : " (dry run)"}`);
  console.log("");
  console.log("Input");
  for (const line of describeInputSelection(resolvedInput)) {
    console.log(line);
  }
  console.log(`✓ review artifact: ${preview.metadata.reviewInputFile}`);
  console.log("");
  console.log("Destination");
  console.log(`✓ channel (hard-locked): ${destination}`);
  console.log(`✓ source channel is never writable: ${FORBIDDEN_SOURCE_CHANNEL_ID}`);
  console.log("");
  console.log("Plan");
  console.log(`✓ ${preview.messages.length} messages total: 1 parent + ${preview.messages.length - 1} thread replies`);
  console.log(`✓ ${published.size} already published, ${outstanding.length} outstanding`);
  if (parentTs) {
    console.log(`✓ existing thread parent: ${parentTs}`);
  }
  for (const message of preview.messages) {
    const state = published.has(message.index) ? "already published" : "would post";
    console.log(`    ${message.index}. ${message.kind.padEnd(6)} ${message.title} — ${state}`);
  }
  console.log("");

  if (complete) {
    console.log("✓ This preview has already been fully published. Nothing to do.");
    console.log("  Duplicate publication is refused; delete the receipt only if you intend to repost.");
    return;
  }

  if (!publishConfirmed) {
    console.log("Safety");
    console.log("✓ Zero Slack API calls made");
    console.log("✓ Nothing was posted");
    console.log("✓ No receipt written");
    console.log("");
    console.log("  This command is dry-run by default. To publish for real:");
    console.log(`    npm run intelligence:review-slack-publish -- --input=${resolvedInput.relativePath} --publish`);
    return;
  }

  let token: string;
  try {
    token = getEnv().SLACK_BOT_TOKEN;
  } catch (err) {
    if (err instanceof EnvValidationError) {
      fail(`✗ ${err.message}`);
    }
    throw err;
  }

  const runId = crypto.randomUUID().slice(0, 8);
  const startedAt = new Date();

  let outcome;
  try {
    outcome = await runReviewPublication({
      preview,
      postFn: createSlackPostFn(token),
      published,
      ...(parentTs ? { parentTs } : {}),
      onProgress: (result) => {
        const label =
          result.status === "success"
            ? `✓ ${result.slackTs}`
            : result.status === "skipped"
              ? "• already published"
              : `✗ ${result.error ?? "failed"}`;
        console.log(`[${result.index}/${preview.messages.length}] ${result.title} → ${label}`);
      },
    });
  } catch (err) {
    if (err instanceof PublicationSafetyError) {
      fail(`✗ ${err.message}`);
    }
    throw err;
  }

  const completedAt = new Date();
  const failures = outcome.results.filter((r) => r.status === "failed").length;
  const receipt = {
    runId,
    previewInputFile: resolvedInput.relativePath,
    reviewInputFile: preview.metadata.reviewInputFile,
    windowTag: preview.metadata.windowTag,
    destinationChannelId: destination,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    parentTs: outcome.parentTs ?? null,
    status: failures === 0 ? "completed" : "partial",
    requestedMessageCount: preview.messages.length,
    results: outcome.results,
  };

  const receiptPath = path.join(
    PUBLICATIONS_DIR,
    `review-slack-publication-${preview.metadata.windowTag}-${completedAt.toISOString().slice(0, 10)}-${runId}.json`,
  );
  await fs.mkdir(PUBLICATIONS_DIR, { recursive: true });
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  console.log("");
  console.log("Receipt");
  console.log(`✓ ${path.relative(process.cwd(), receiptPath)}`);
  if (failures > 0) {
    console.log("");
    console.log(`⚠ ${failures} message(s) failed. Re-run with --publish to post only the outstanding ones.`);
  }
}

main().catch((err: unknown) => {
  fail(`✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});
