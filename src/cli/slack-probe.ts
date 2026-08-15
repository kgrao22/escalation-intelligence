import { EnvValidationError } from "../config/env.js";
import { getEnv } from "../config/loadEnv.js";
import { createSlackReadOnlyClient } from "../slack/client.js";
import {
  checkAuth,
  checkChannelAccess,
  explainSlackErrorCode,
  extractSlackErrorCode,
  fetchRecentMessageSummaries,
  formatTimestamp,
} from "../slack/connectivity.js";
import { assertSafePostTarget } from "../slack/safety.js";

const MAX_PROBE_MESSAGES = 5;

function fail(message: string): never {
  console.error(message);
  console.log("");
  console.log("Slack connectivity probe failed.");
  process.exit(1);
}

async function main() {
  console.log("Escalation Intelligence — Slack Connectivity Probe");
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

  const client = createSlackReadOnlyClient(env.SLACK_BOT_TOKEN);

  // --- Authentication ---
  console.log("Authentication");
  try {
    const auth = await checkAuth(client);
    if (!auth.ok) {
      fail("✗ Slack authentication failed (auth.test returned ok: false).");
    }
    console.log("✓ Connected to Slack");
    console.log(`✓ Workspace: ${auth.team ?? "(unknown)"}`);
    console.log(`✓ Bot/User: ${auth.user ?? auth.botId ?? "(unknown)"}`);
  } catch (err) {
    const code = extractSlackErrorCode(err);
    if (code) {
      fail(`✗ Slack authentication failed: ${code}\n  ${explainSlackErrorCode(code)}`);
    }
    fail(`✗ Slack authentication failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log("");

  // --- Channels ---
  console.log("Channels");

  const sourceCheck = await checkChannelAccess(client, env.SLACK_SOURCE_CHANNEL_ID);
  if (!sourceCheck.ok) {
    const explanation = sourceCheck.errorCode ? explainSlackErrorCode(sourceCheck.errorCode) : "";
    fail(
      `✗ Source channel (${env.SLACK_SOURCE_CHANNEL_ID}) is not accessible` +
        (sourceCheck.errorCode ? `: ${sourceCheck.errorCode}` : "") +
        (explanation ? `\n  ${explanation}` : ""),
    );
  }
  console.log("✓ Source channel accessible");
  console.log(`  ID: ${sourceCheck.channelId}`);
  console.log("  Mode: READ ONLY");
  console.log("");

  const destCheck = await checkChannelAccess(client, env.SLACK_DEST_CHANNEL_ID);
  if (!destCheck.ok) {
    const explanation = destCheck.errorCode ? explainSlackErrorCode(destCheck.errorCode) : "";
    fail(
      `✗ Destination channel (${env.SLACK_DEST_CHANNEL_ID}) is not accessible` +
        (destCheck.errorCode ? `: ${destCheck.errorCode}` : "") +
        (explanation ? `\n  ${explanation}` : ""),
    );
  }
  console.log("✓ Destination channel accessible");
  console.log(`  ID: ${destCheck.channelId}`);
  console.log("  Mode: REPORT OUTPUT ONLY");
  console.log("");

  // --- Recent source messages (connectivity test only — capped, not a full fetch) ---
  console.log("Recent source messages");
  const messages = await fetchRecentMessageSummaries(client, env.SLACK_SOURCE_CHANNEL_ID, MAX_PROBE_MESSAGES);
  console.log(`✓ Retrieved ${messages.length} message${messages.length === 1 ? "" : "s"}`);
  console.log("");
  messages.forEach((message, index) => {
    console.log(`${index + 1}. ${formatTimestamp(message.ts)}`);
    console.log(`   author: ${message.authorId ?? "(unknown)"}`);
    console.log(`   replies: ${message.replyCount}`);
    console.log(`   preview: "${message.preview}"`);
    console.log("");
  });

  // --- Safety ---
  console.log("Safety");
  try {
    assertSafePostTarget({
      destinationChannelId: env.SLACK_DEST_CHANNEL_ID,
      sourceChannelId: env.SLACK_SOURCE_CHANNEL_ID,
    });
  } catch (err) {
    fail(`✗ ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log("✓ Source and destination are different");
  console.log("✓ No Slack messages were posted");
  console.log("");

  console.log("Slack connectivity probe passed.");
}

main().catch((err: unknown) => {
  fail(`✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});
