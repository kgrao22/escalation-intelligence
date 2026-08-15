import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { EnvValidationError } from "../config/env.js";
import { getEnv } from "../config/loadEnv.js";
import {
  analysePublicationState,
  publicationReceiptFilePath,
  writePublicationReceipt,
  type PublicationReceipt,
} from "../persistence/publicationReceipt.js";
import { windowTagForDays } from "../persistence/datedFiles.js";
import { describeInputSelection, InputResolutionError, resolveInputFile } from "../persistence/resolveInput.js";
import type { SlackPreviewOutput } from "../persistence/slackPreviewOutput.js";
import { createPublisher, createSlackPostFn } from "../slackPublishing/client.js";
import { buildPublicationPlan, buildResumePlan, describePlanLine } from "../slackPublishing/publishPlan.js";
import { runPublication, type PublicationProgressEvent } from "../slackPublishing/runPublication.js";
import {
  assertPublicationSafety,
  EXPECTED_DESTINATION_CHANNEL_ID,
  PublicationSafetyError,
} from "../slackPublishing/safety.js";
import { parseSlackPublishArgs } from "./slackPublishArgs.js";

const INTELLIGENCE_DATA_DIR = path.resolve(process.cwd(), "data", "intelligence");
const PUBLICATIONS_DIR = path.join(INTELLIGENCE_DATA_DIR, "publications");

function fail(message: string): never {
  console.error(message);
  console.log("");
  console.log("Slack publication aborted. Nothing was posted.");
  process.exit(1);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function loadReceipts(): Promise<PublicationReceipt[]> {
  let filenames: string[];
  try {
    filenames = await fs.readdir(PUBLICATIONS_DIR);
  } catch {
    return [];
  }

  const receipts: PublicationReceipt[] = [];
  for (const filename of filenames) {
    if (!filename.endsWith(".json")) {
      continue;
    }
    try {
      receipts.push(await readJsonFile<PublicationReceipt>(path.join(PUBLICATIONS_DIR, filename)));
    } catch {
      // A corrupt receipt cannot prove a prior publication; ignore it.
    }
  }
  return receipts;
}

function printProgress(event: PublicationProgressEvent): void {
  console.log(`[${event.index}/${event.total}] ${event.label}`);
  if (event.outcome === "failed") {
    console.log(`✗ failed — ${event.errorMessage ?? "unknown error"}`);
    return;
  }
  console.log(
    event.type === "overview" ? `✓ posted — ts ${event.slackTs}` : "✓ posted as thread reply",
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
    args = parseSlackPublishArgs(process.argv.slice(2));
  } catch (err) {
    fail(`✗ ${err instanceof Error ? err.message : String(err)}`);
  }

  let previewInput;
  try {
    previewInput = await resolveInputFile({
      explicitInput: args.input,
      defaultDir: INTELLIGENCE_DATA_DIR,
      prefix: "slack-preview",
      missingHint: "Run `npm run intelligence:slack-preview` first, or pass --input=<path>.",
    });
  } catch (err) {
    if (err instanceof InputResolutionError) {
      fail(`✗ ${err.message}`);
    }
    throw err;
  }

  let preview: SlackPreviewOutput;
  try {
    preview = await readJsonFile<SlackPreviewOutput>(previewInput.absolutePath);
    if (!Array.isArray(preview.issues) || typeof preview.overview?.text !== "string") {
      throw new Error("preview artifact is missing an overview or issues array");
    }
  } catch (err) {
    fail(`✗ Failed to read ${previewInput.relativePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(`Escalation Intelligence — Slack Publisher${args.publish ? "" : " (dry run)"}`);
  console.log("");
  console.log("Input");
  for (const line of describeInputSelection(previewInput)) {
    console.log(line);
  }
  console.log(`✓ ${1 + preview.issues.length} messages available`);
  console.log("");

  // Every safety precondition runs before anything else, on both the dry-run
  // and live paths, so a misconfiguration is caught during validation.
  try {
    assertPublicationSafety({
      destinationChannelId: env.SLACK_DEST_CHANNEL_ID,
      sourceChannelId: env.SLACK_SOURCE_CHANNEL_ID,
      previewDestinationChannelId: preview.metadata.slackDestinationChannelId,
      previewPosted: preview.metadata.posted,
    });
  } catch (err) {
    if (err instanceof PublicationSafetyError) {
      fail(`✗ ${err.message}`);
    }
    throw err;
  }

  console.log("Destination");
  console.log(`✓ ${env.SLACK_DEST_CHANNEL_ID}`);
  console.log("✓ source channel differs");
  console.log("✓ destination matches the channel hard-locked in code");
  console.log("✓ preview destination matches config");
  console.log("✓ preview is not already marked as posted");
  console.log("");

  const availableMessageCount = 1 + preview.issues.length;
  const state = analysePublicationState(
    await loadReceipts(),
    previewInput.relativePath,
    env.SLACK_DEST_CHANNEL_ID,
    availableMessageCount,
  );

  // Fully published always blocks, whether it happened in one run or across a
  // limited run plus resumes.
  if (state.fullyPublished) {
    fail(
      `✗ This preview has already been fully published (${state.publishedMessageCount}/${availableMessageCount} messages across ` +
        `${state.receipts.length} run(s)). Generate a fresh preview rather than reposting it.`,
    );
  }

  if (args.resume && !state.hasPriorPublication) {
    fail(
      "✗ --resume was supplied but no prior publication receipt exists for this preview and destination.\n" +
        "  Run without --resume to publish it for the first time.",
    );
  }

  if (!args.resume && state.hasPriorPublication) {
    fail(
      `✗ This preview already has a partial publication (${state.publishedMessageCount}/${availableMessageCount} messages posted).\n` +
        `  Re-running would repost message 1 and start a second thread.\n` +
        "  Add --resume to continue the existing thread with the outstanding messages.",
    );
  }

  let resumeOverviewTs: string | undefined;
  if (args.resume) {
    if (!state.overviewPublished || !state.overviewTs) {
      fail(
        "✗ Cannot resume: the existing receipt has no successfully published overview to reply into.\n" +
          "  Inspect the receipt and Slack thread before continuing.",
      );
    }
    resumeOverviewTs = state.overviewTs;

    console.log("Resume source");
    console.log(`✓ ${state.receipts.length} prior run(s) recorded for this preview`);
    console.log(`✓ overview ts ${state.overviewTs} (from run ${state.overviewTsFromRunId})`);
    console.log(`✓ ${state.publishedMessageCount}/${availableMessageCount} messages already published`);
    console.log(`✓ ${state.missingIndexes.length} outstanding`);
    console.log("");
  }

  const plan = args.resume
    ? buildResumePlan(preview, state.publishedIndexes, args.limit)
    : buildPublicationPlan(preview, args.limit);

  if (plan.length === 0) {
    fail("✗ Nothing to publish.");
  }

  console.log(args.resume ? "Remaining plan" : "Plan");
  for (const message of plan) {
    console.log(describePlanLine(message));
  }
  if (args.limit !== undefined && plan.length < (args.resume ? state.missingIndexes.length : availableMessageCount)) {
    console.log(
      `(limited to ${plan.length} of ${args.resume ? state.missingIndexes.length : availableMessageCount} ${args.resume ? "outstanding " : ""}messages)`,
    );
  }
  console.log("");

  if (plan.some((message) => message.type === "overview") && args.resume) {
    fail("✗ Internal safety check failed: a resume plan must never contain the overview.");
  }

  if (!args.publish) {
    console.log("Safety");
    console.log("✓ --publish not supplied");
    console.log("✓ Zero Slack API calls made");
    console.log("✓ Nothing posted");
    console.log("✓ Preview artifact not modified");
    return;
  }

  console.log("LIVE SLACK PUBLICATION ENABLED");
  console.log("");
  console.log("Destination:");
  console.log(EXPECTED_DESTINATION_CHANNEL_ID);
  console.log("");
  console.log(`Messages to publish:`);
  console.log(`${plan.length}`);
  console.log("");

  const publisher = createPublisher(createSlackPostFn(env.SLACK_BOT_TOKEN), env.SLACK_DEST_CHANNEL_ID);
  const runId = randomUUID().slice(0, 8);
  const startedAt = new Date();

  const rawReceipt = await runPublication({
    plan,
    publisher,
    previewInputFile: previewInput.relativePath,
    destinationChannelId: env.SLACK_DEST_CHANNEL_ID,
    runId,
    startedAt,
    ...(resumeOverviewTs ? { resumeOverviewTs } : {}),
    labelFor: (message) => {
      if (message.type === "overview") {
        return "overview";
      }
      const issue = preview.issues.find((candidate) => candidate.groupId === message.groupId);
      const firstLine = issue?.text.split("\n")[0] ?? `issue ${message.index - 1}`;
      return firstLine.replace(/^\*\d+\.\s*/, "").replace(/\*\s*[🔴🟠🟢]?$/, "").trim();
    },
    onProgress: printProgress,
  });

  // Completeness spans every run for this preview, not just this one — a
  // successful limited run must not read as a fully published preview.
  const publishedAfterRun = new Set([
    ...state.publishedIndexes,
    ...rawReceipt.publishedMessages.map((message) => message.index),
  ]);
  const receipt: PublicationReceipt = {
    ...rawReceipt,
    availableMessageCount,
    publishedMessageCount: rawReceipt.publishedMessages.length,
    publicationCompleteForPreview: publishedAfterRun.size === availableMessageCount,
    ...(args.resume
      ? { isResume: true, ...(state.receipts.at(-1)?.runId ? { resumedFromRunId: state.receipts.at(-1)!.runId } : {}) }
      : {}),
  };

  const windowTag =
    previewInput.windowTag ??
    (typeof preview.metadata.sourceWindowDays === "number"
      ? windowTagForDays(preview.metadata.sourceWindowDays)
      : null);
  const receiptPath = publicationReceiptFilePath(PUBLICATIONS_DIR, startedAt, runId, windowTag);
  await writePublicationReceipt(receipt, receiptPath);

  const posted = receipt.publishedMessages.length;
  const topLevel = receipt.publishedMessages.filter((message) => message.type === "overview").length;
  const replies = receipt.publishedMessages.filter((message) => message.type === "issue").length;

  console.log("");
  if (receipt.status === "completed") {
    console.log("Completed");
  } else {
    console.log(receipt.status === "failed" ? "Failed" : "Partial failure");
  }
  console.log(`✓ ${posted}/${plan.length} messages posted`);
  console.log(`✓ ${topLevel} top-level message${topLevel === 1 ? "" : "s"}`);
  console.log(`✓ ${replies} thread repl${replies === 1 ? "y" : "ies"}`);
  for (const failure of receipt.failures) {
    console.log(`✗ message ${failure.index} (${failure.type}) failed: ${failure.error}`);
  }
  console.log("");
  console.log("Receipt");
  console.log(`✓ ${path.relative(process.cwd(), receiptPath)}`);
  console.log("");
  console.log("The reviewed preview artifact was not modified.");

  if (receipt.status !== "completed") {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  fail(`✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});
