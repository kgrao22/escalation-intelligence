import fs from "node:fs/promises";
import path from "node:path";
import { EnvValidationError } from "../config/env.js";
import { getEnv } from "../config/loadEnv.js";
import { windowTagForDays } from "../persistence/datedFiles.js";
import type { RecommendationOutput } from "../persistence/recommendationOutput.js";
import type { ReportOutput } from "../persistence/reportOutput.js";
import { describeInputSelection, InputResolutionError, resolveInputFile } from "../persistence/resolveInput.js";
import {
  slackPreviewOutputFilePath,
  writeSlackPreviewOutput,
  type SlackPreviewOutput,
} from "../persistence/slackPreviewOutput.js";
import { hasShortDisplayName } from "../slackReport/displayNames.js";
import { PreviewJoinError, renderSlackReportPreview } from "../slackReport/renderPreview.js";
import { parseSlackPreviewArgs } from "./slackPreviewArgs.js";

const INTELLIGENCE_DATA_DIR = path.resolve(process.cwd(), "data", "intelligence");
const SEPARATOR = "=".repeat(50);

/** Slack renders long messages poorly well before its hard limit. */
const READABLE_MESSAGE_LIMIT = 3000;

function fail(message: string): never {
  console.error(message);
  console.log("");
  console.log("Slack preview failed.");
  process.exit(1);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
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
    args = parseSlackPreviewArgs(process.argv.slice(2));
  } catch (err) {
    fail(`✗ ${err instanceof Error ? err.message : String(err)}`);
  }

  let reportInput;
  let recommendationsInput;
  try {
    reportInput = await resolveInputFile({
      explicitInput: args.report,
      defaultDir: INTELLIGENCE_DATA_DIR,
      prefix: "report",
      missingHint: "Run `npm run intelligence:report` first, or pass --report=<path>.",
    });
    recommendationsInput = await resolveInputFile({
      explicitInput: args.recommendations,
      defaultDir: INTELLIGENCE_DATA_DIR,
      prefix: "recommendations",
      missingHint: "Run `npm run intelligence:recommend` first, or pass --recommendations=<path>.",
    });
  } catch (err) {
    if (err instanceof InputResolutionError) {
      fail(`✗ ${err.message}`);
    }
    throw err;
  }

  let report: ReportOutput;
  let recommendations: RecommendationOutput;
  try {
    report = await readJsonFile<ReportOutput>(reportInput.absolutePath);
    recommendations = await readJsonFile<RecommendationOutput>(recommendationsInput.absolutePath);
  } catch (err) {
    fail(`✗ Failed to read input files: ${err instanceof Error ? err.message : String(err)}`);
  }

  let preview;
  try {
    preview = renderSlackReportPreview(report, recommendations, {
      ...(args.totalEscalations !== undefined ? { totalTechnicalEscalations: args.totalEscalations } : {}),
    });
  } catch (err) {
    if (err instanceof PreviewJoinError) {
      fail(`✗ ${err.message}`);
    }
    throw err;
  }

  console.log("Escalation Intelligence — Slack Report Preview");
  console.log("");
  console.log("Input");
  for (const line of describeInputSelection(reportInput)) {
    console.log(line);
  }
  for (const line of describeInputSelection(recommendationsInput)) {
    console.log(line);
  }
  console.log("");

  console.log(SEPARATOR);
  console.log("MESSAGE 1 — OVERVIEW");
  console.log(SEPARATOR);
  console.log("");
  console.log(preview.overview.text);
  console.log("");

  preview.issues.forEach((message, index) => {
    console.log(SEPARATOR);
    console.log(`MESSAGE ${index + 2} — ISSUE`);
    console.log(SEPARATOR);
    console.log("");
    console.log(message.text);
    console.log("");
  });

  const allMessages = [preview.overview, ...preview.issues];
  const longest = allMessages.reduce((max, message) => Math.max(max, message.characterCount), 0);
  const oversized = allMessages.filter((message) => message.characterCount > READABLE_MESSAGE_LIMIT);

  const createdAt = new Date();
  const windowTag =
    reportInput.windowTag ??
    (typeof report.metadata.sourceWindowDays === "number"
      ? windowTagForDays(report.metadata.sourceWindowDays)
      : null);

  const output: SlackPreviewOutput = {
    metadata: {
      reportInputFile: reportInput.relativePath,
      recommendationsInputFile: recommendationsInput.relativePath,
      createdAt: createdAt.toISOString(),
      ...(typeof report.metadata.sourceWindowDays === "number"
        ? { sourceWindowDays: report.metadata.sourceWindowDays }
        : {}),
      messageCount: allMessages.length,
      slackDestinationChannelId: env.SLACK_DEST_CHANNEL_ID,
      posted: false,
      omittedGroupIds: preview.omittedGroupIds,
      longestMessageCharacterCount: longest,
    },
    overview: preview.overview,
    issues: preview.issues,
  };

  const outputFilePath = slackPreviewOutputFilePath(INTELLIGENCE_DATA_DIR, createdAt, windowTag);
  await writeSlackPreviewOutput(output, outputFilePath);

  console.log(SEPARATOR);
  console.log("PREVIEW SUMMARY");
  console.log(SEPARATOR);
  console.log("");
  console.log(`Messages:        ${allMessages.length} (1 overview + ${preview.issues.length} issues)`);
  console.log(`Longest message: ${longest} characters`);
  console.log(`Destination:     ${env.SLACK_DEST_CHANNEL_ID} (metadata only — nothing sent)`);

  for (const message of oversized) {
    console.log(`⚠ Message for ${message.groupId ?? "overview"} is ${message.characterCount} characters — may read poorly in Slack.`);
  }
  if (preview.omittedGroupIds.length > 0) {
    console.log(`⚠ ${preview.omittedGroupIds.length} issues omitted (no successful recommendation).`);
  }

  const unshortened = preview.issues.filter((message) => {
    const issue = report.report.issues.find((candidate) => candidate.groupId === message.groupId);
    return issue !== undefined && !hasShortDisplayName(issue.name);
  });
  if (unshortened.length > 0) {
    console.log(`⚠ ${unshortened.length} issues have no short display name and use their full persisted name.`);
  }

  console.log("");
  console.log("Output");
  console.log(`✓ ${path.relative(process.cwd(), outputFilePath)}`);
  console.log("");
  console.log("Safety");
  console.log("✓ Zero Slack API calls made");
  console.log("✓ Zero Anthropic/Voyage calls made");
  console.log("✓ Nothing posted to Slack");
}

main().catch((err: unknown) => {
  fail(`✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});
