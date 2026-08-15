import path from "node:path";
import { EnvValidationError } from "../config/env.js";
import { getEnv } from "../config/loadEnv.js";
import { outputFilePath, writeFetchOutput, type FetchOutput } from "../persistence/fetchOutput.js";
import { createSlackReadOnlyClient } from "../slack/client.js";
import { explainSlackErrorCode, extractSlackErrorCode } from "../slack/connectivity.js";
import {
  assembleEscalationThread,
  computeOldestTs,
  fetchAllTopLevelMessages,
  type EscalationThread,
  type RawTopLevelMessage,
} from "../slack/escalationThreads.js";
import { isSystemNoiseMessage } from "../slack/filters.js";
import { parseFetchArgs } from "./args.js";

function fail(message: string): never {
  console.error(message);
  console.log("");
  console.log("Slack fetch failed.");
  process.exit(1);
}

async function main() {
  console.log("Escalation Intelligence — Slack Fetch");
  console.log("");

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
    args = parseFetchArgs(process.argv.slice(2), env.SLACK_DAYS_BACK);
  } catch (err) {
    fail(`✗ ${err instanceof Error ? err.message : String(err)}`);
  }
  const daysBack = args.daysBack;

  console.log("Window");
  console.log(`✓ Last ${daysBack} days`);
  console.log("");

  console.log("Source");
  console.log(`✓ ${env.SLACK_SOURCE_CHANNEL_ID}`);
  console.log("✓ READ ONLY");
  console.log("");

  const fetchedAt = new Date();
  const oldestTs = computeOldestTs(daysBack, fetchedAt);
  const plannedOutputPath = outputFilePath(path.resolve(process.cwd(), "data", "slack"), fetchedAt, daysBack);

  if (args.dryRun) {
    console.log("Plan (dry run)");
    console.log(`- lookback window: ${daysBack} days`);
    console.log(`- oldest message timestamp: ${oldestTs} (${new Date(Number.parseFloat(oldestTs) * 1000).toISOString()})`);
    console.log(`- output file: ${path.relative(process.cwd(), plannedOutputPath)}`);
    console.log("");
    console.log("Safety");
    console.log("✓ Zero Slack API calls made");
    console.log("✓ No production data fetched");
    console.log("✓ No output file written");
    return;
  }

  const client = createSlackReadOnlyClient(env.SLACK_BOT_TOKEN);

  let rawMessages: RawTopLevelMessage[];
  try {
    rawMessages = await fetchAllTopLevelMessages(client, env.SLACK_SOURCE_CHANNEL_ID, oldestTs);
  } catch (err) {
    const code = extractSlackErrorCode(err);
    if (code) {
      fail(`✗ Failed to fetch channel history: ${code}\n  ${explainSlackErrorCode(code)}`);
    }
    fail(`✗ Failed to fetch channel history: ${err instanceof Error ? err.message : String(err)}`);
  }

  const systemMessages = rawMessages.filter(isSystemNoiseMessage);
  const candidates = rawMessages.filter((message) => !isSystemNoiseMessage(message));

  const threads: EscalationThread[] = [];
  for (const message of candidates) {
    try {
      threads.push(await assembleEscalationThread(client, env.SLACK_SOURCE_CHANNEL_ID, message));
    } catch (err) {
      const code = extractSlackErrorCode(err);
      if (code) {
        fail(
          `✗ Failed to fetch thread replies for message ${message.ts}: ${code}\n` +
            `  ${explainSlackErrorCode(code)}\n` +
            "  Stopping — no partial output file was written.",
        );
      }
      fail(
        `✗ Failed to fetch thread replies for message ${message.ts}: ` +
          `${err instanceof Error ? err.message : String(err)}\n` +
          "  Stopping — no partial output file was written.",
      );
    }
  }

  const totalReplies = threads.reduce((sum, thread) => sum + thread.replies.length, 0);
  const threadsWithReplies = threads.filter((thread) => thread.replies.length > 0).length;
  const maxReplies = threads.reduce((max, thread) => Math.max(max, thread.replies.length), 0);
  const averageRepliesPerThread = threads.length > 0 ? totalReplies / threads.length : 0;
  const messagesWithoutReplies = threads.length - threadsWithReplies;

  console.log("Fetched");
  console.log(`✓ ${rawMessages.length} top-level messages`);
  console.log(`✓ ${threadsWithReplies} threads with replies`);
  console.log(`✓ ${totalReplies} replies`);
  console.log(`✓ ${systemMessages.length} Slack system messages filtered`);
  console.log(`✓ ${threads.length} escalation candidates retained`);
  console.log("");

  const output: FetchOutput = {
    metadata: {
      channelId: env.SLACK_SOURCE_CHANNEL_ID,
      daysBack,
      fetchedAt: fetchedAt.toISOString(),
      rawTopLevelMessages: rawMessages.length,
      systemMessagesFiltered: systemMessages.length,
      analysisThreads: threads.length,
      threadsWithReplies,
      totalReplies,
    },
    threads,
  };

  await writeFetchOutput(output, plannedOutputPath);

  console.log("Output");
  console.log(`✓ ${path.relative(process.cwd(), plannedOutputPath)}`);
  console.log("");

  console.log("Thread statistics");
  console.log(`- average replies per thread: ${averageRepliesPerThread.toFixed(2)}`);
  console.log(`- max replies: ${maxReplies}`);
  console.log(`- messages without replies: ${messagesWithoutReplies}`);
  console.log("");

  console.log("Safety");
  console.log("✓ No Slack messages were posted");
  console.log("✓ Source channel was not mutated");
  console.log("");

  console.log("Slack fetch complete.");
}

main().catch((err: unknown) => {
  fail(`✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});
