import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { EnvValidationError } from "../config/env.js";
import { getEnv } from "../config/loadEnv.js";
import {
  deletionReceiptFilePath,
  writeDeletionReceipt,
  type DeletionReceipt,
  type DeletionResultItem,
} from "../persistence/deletionReceiptOutput.js";
import { createSlackDeleteFn } from "../slackCleanup/client.js";
import {
  assertCleanupSafety,
  CleanupSafetyError,
  collectDeletionTargets,
  receiptMatchesWindow,
  type PublicationReceiptLike,
  type ReceiptFile,
} from "../slackCleanup/collectDeletionTargets.js";
import { runDeletion } from "../slackCleanup/runDeletion.js";
import { EXPECTED_DESTINATION_CHANNEL_ID, FORBIDDEN_SOURCE_CHANNEL_ID } from "../slackPublishing/safety.js";
import { parseSlackCleanupArgs } from "./slackCleanupArgs.js";

const PUBLICATIONS_DIR = path.resolve(process.cwd(), "data", "intelligence", "publications");

function fail(message: string): never {
  console.error(message);
  console.log("");
  console.log("Slack cleanup failed. Nothing was deleted.");
  process.exit(1);
}

async function loadReceipts(windowTag: string): Promise<ReceiptFile[]> {
  let filenames: string[];
  try {
    filenames = await fs.readdir(PUBLICATIONS_DIR);
  } catch {
    return [];
  }

  const files: ReceiptFile[] = [];
  for (const filename of filenames.sort()) {
    if (!receiptMatchesWindow(filename, windowTag)) {
      continue;
    }
    try {
      const receipt = JSON.parse(
        await fs.readFile(path.join(PUBLICATIONS_DIR, filename), "utf8"),
      ) as PublicationReceiptLike;
      files.push({ filename, receipt });
    } catch {
      // A corrupt receipt contributes no targets — it never widens the set.
    }
  }
  return files;
}

async function main() {
  let args;
  try {
    args = parseSlackCleanupArgs(process.argv.slice(2));
  } catch (err) {
    fail(`✗ ${err instanceof Error ? err.message : String(err)}`);
  }

  const receipts = await loadReceipts(args.window);
  if (receipts.length === 0) {
    fail(`✗ No ${args.window} publication receipts found in data/intelligence/publications/.`);
  }

  let targets;
  try {
    targets = collectDeletionTargets(receipts, args.window);
    assertCleanupSafety(targets, args.window);
  } catch (err) {
    if (err instanceof CleanupSafetyError) {
      fail(`✗ ${err.message}`);
    }
    throw err;
  }

  const replies = targets.filter((target) => target.kind === "reply");
  const overviews = targets.filter((target) => target.kind === "overview");

  console.log(`Escalation Intelligence — Slack Cleanup${args.deleteConfirmed ? " (LIVE DELETE)" : " (preview)"}`);
  console.log("");
  console.log("Scope");
  console.log(`✓ window: ${args.window}`);
  console.log(`✓ destination channel (hard-locked): ${EXPECTED_DESTINATION_CHANNEL_ID}`);
  console.log(`✓ source channel is never a target:  ${FORBIDDEN_SOURCE_CHANNEL_ID}`);
  console.log(`✓ ${receipts.length} publication receipt(s) read:`);
  for (const receipt of receipts) {
    console.log(`    ${receipt.filename}`);
  }
  console.log("✓ targets come only from these receipts — no channel search, no text matching");
  console.log("");

  console.log(`Proposed deletions (${targets.length} messages)`);
  console.log("");
  console.log(`  Thread replies first (${replies.length}):`);
  for (const [index, target] of replies.entries()) {
    console.log(`    ${index + 1}. ts ${target.ts}   ← ${target.sourceReceiptFile}`);
  }
  console.log(`  Parent message last (${overviews.length}):`);
  for (const [index, target] of overviews.entries()) {
    console.log(`    ${replies.length + index + 1}. ts ${target.ts}   ← ${target.sourceReceiptFile}`);
  }
  console.log("");

  if (!args.deleteConfirmed) {
    console.log("Safety");
    console.log("✓ Zero Slack API calls made");
    console.log("✓ Nothing was deleted");
    console.log("✓ No deletion receipt written");
    console.log("");
    console.log("  This command previews by default. To delete for real, re-run with --delete:");
    console.log(`    npm run intelligence:slack-cleanup -- --window=${args.window} --delete`);
    return;
  }

  let env;
  let token: string;
  try {
    env = getEnv();
    token = env.SLACK_BOT_TOKEN;
  } catch (err) {
    if (err instanceof EnvValidationError) {
      fail(`✗ ${err.message}`);
    }
    throw err;
  }

  const startedAt = new Date();
  const runId = crypto.randomUUID().slice(0, 8);

  console.log("Deleting");
  console.log("");
  const results: DeletionResultItem[] = await runDeletion({
    targets,
    windowTag: args.window,
    deleteFn: createSlackDeleteFn(token),
    onProgress: (result, index, total) => {
      const label =
        result.outcome === "deleted"
          ? "✓ deleted"
          : result.outcome === "already_deleted"
            ? "• already gone"
            : `✗ ${result.error ?? "failed"}`;
      console.log(`[${index}/${total}] ${result.kind.padEnd(8)} ts ${result.ts} → ${label}`);
    },
  });

  const completedAt = new Date();
  const receipt: DeletionReceipt = {
    runId,
    windowTag: args.window,
    channelId: EXPECTED_DESTINATION_CHANNEL_ID,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    sourceReceiptFiles: receipts.map((r) => r.filename),
    requestedCount: targets.length,
    deletedCount: results.filter((r) => r.outcome === "deleted").length,
    alreadyDeletedCount: results.filter((r) => r.outcome === "already_deleted").length,
    failureCount: results.filter((r) => r.outcome === "failed").length,
    results,
  };

  const receiptPath = deletionReceiptFilePath(PUBLICATIONS_DIR, args.window, completedAt, runId);
  await writeDeletionReceipt(receipt, receiptPath);

  console.log("");
  console.log("Results");
  console.log(`✓ deleted:        ${receipt.deletedCount}`);
  console.log(`• already gone:   ${receipt.alreadyDeletedCount}`);
  console.log(`✗ failed:         ${receipt.failureCount}`);
  console.log("");
  console.log("Receipt");
  console.log(`✓ ${path.relative(process.cwd(), receiptPath)}`);
  if (receipt.failureCount > 0) {
    console.log("");
    console.log("  Re-running is safe: already-deleted messages are recorded as such, not retried as errors.");
  }
}

main().catch((err: unknown) => {
  fail(`✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});
