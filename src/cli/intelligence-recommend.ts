import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import fs from "node:fs/promises";
import path from "node:path";
import { EnvValidationError, requireAnthropicApiKey } from "../config/env.js";
import { getEnv } from "../config/loadEnv.js";
import { ISSUE_RECOMMENDATION_PROMPT_VERSION } from "../llm/prompts/issueRecommendation.js";
import { IssueRecommendationLLMOutputSchema } from "../llm/schemas/issueRecommendation.js";
import { createStructuredParseFn } from "../llm/structuredParse.js";
import { windowTagForDays } from "../persistence/datedFiles.js";
import {
  buildPriorRecommendationIndex,
  countRecommendations,
  recommendationOutputFilePath,
  writeRecommendationOutput,
  type RecommendationOutput,
} from "../persistence/recommendationOutput.js";
import type { ReportOutput } from "../persistence/reportOutput.js";
import { describeInputSelection, InputResolutionError, resolveInputFile } from "../persistence/resolveInput.js";
import {
  limitIssues,
  runRecommendations,
  type RecommendationProgressEvent,
} from "../recommendations/runRecommendations.js";
import { parseRecommendArgs } from "./recommendArgs.js";

const INTELLIGENCE_DATA_DIR = path.resolve(process.cwd(), "data", "intelligence");

/** Two short sentences plus a rationale — no long generation. */
const MAX_OUTPUT_TOKENS = 1024;

function fail(message: string): never {
  console.error(message);
  console.log("");
  console.log("Action recommendation failed.");
  process.exit(1);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function loadPriorRecommendations(): Promise<RecommendationOutput[]> {
  let filenames: string[];
  try {
    filenames = await fs.readdir(INTELLIGENCE_DATA_DIR);
  } catch {
    return [];
  }

  const outputs: RecommendationOutput[] = [];
  for (const filename of filenames) {
    if (!/^recommendations(?:-\d+d)?-\d{4}-\d{2}-\d{2}\.json$/.test(filename)) {
      continue;
    }
    try {
      outputs.push(await readJsonFile<RecommendationOutput>(path.join(INTELLIGENCE_DATA_DIR, filename)));
    } catch {
      // A corrupt prior file simply doesn't contribute to resumability.
    }
  }
  return outputs;
}

function printProgress(event: RecommendationProgressEvent): void {
  const prefix = `[${event.index}/${event.total}] ${event.name ?? event.groupId}`;
  if (event.outcome === "failed") {
    console.log(`${prefix} → ✗ ${event.errorMessage ?? "unknown error"}`);
    return;
  }
  const suffix = event.outcome === "cached" ? " (cached)" : "";
  console.log(`${prefix} → ${event.recommendedAction} / ${event.priority}${suffix}`);
}

function printCounts(label: string, counts: Record<string, number>): void {
  console.log(label);
  for (const [key, count] of Object.entries(counts)) {
    if (count > 0) {
      console.log(`  ${key}: ${count}`);
    }
  }
  console.log("");
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
    args = parseRecommendArgs(process.argv.slice(2));
  } catch (err) {
    fail(`✗ ${err instanceof Error ? err.message : String(err)}`);
  }

  let reportInput;
  try {
    reportInput = await resolveInputFile({
      explicitInput: args.input,
      defaultDir: INTELLIGENCE_DATA_DIR,
      prefix: "report",
      missingHint: "Run `npm run intelligence:report` first, or pass --input=<path>.",
    });
  } catch (err) {
    if (err instanceof InputResolutionError) {
      fail(`✗ ${err.message}`);
    }
    throw err;
  }

  let reportOutput: ReportOutput;
  try {
    reportOutput = await readJsonFile<ReportOutput>(reportInput.absolutePath);
    if (!Array.isArray(reportOutput.report?.issues)) {
      throw new Error("missing or invalid `report.issues` array");
    }
  } catch (err) {
    fail(`✗ Failed to read ${reportInput.relativePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const model = args.model ?? env.ANTHROPIC_MODEL;
  const allIssues = reportOutput.report.issues;
  const issues = limitIssues(allIssues, args.limit);

  console.log(`Escalation Intelligence — Action Recommendations${args.dryRun ? " (dry run)" : ""}`);
  console.log("");
  console.log("Input");
  for (const line of describeInputSelection(reportInput)) {
    console.log(line);
  }
  console.log(`✓ ${allIssues.length} recurring issues`);
  if (args.limit !== undefined) {
    console.log(`✓ limited to ${issues.length} for this run`);
  }
  console.log("");

  if (args.dryRun) {
    console.log("Plan");
    console.log(`- model: ${model}`);
    console.log(`- prompt version: ${ISSUE_RECOMMENDATION_PROMPT_VERSION}`);
    console.log(`- estimated Anthropic calls: ${issues.length} (one per recurring issue, minus any reused)`);
    console.log("");
    console.log("Safety");
    console.log("✓ Zero Anthropic API calls made");
    console.log("✓ No output file written");
    console.log("✓ Nothing posted to Slack");
    return;
  }

  if (issues.length === 0) {
    fail("✗ No recurring issues to analyse.");
  }

  let apiKey: string;
  try {
    apiKey = requireAnthropicApiKey(env);
  } catch (err) {
    if (err instanceof EnvValidationError) {
      fail(`✗ ${err.message}`);
    }
    throw err;
  }

  const client = new Anthropic({ apiKey });
  const parseFn = createStructuredParseFn(
    client,
    zodOutputFormat(IssueRecommendationLLMOutputSchema),
    MAX_OUTPUT_TOKENS,
  );

  // Only reuse recommendations produced from the SAME report artifact. The
  // cache key is (groupId + promptVersion + model), which carries no evidence
  // provenance — and a group id is a hash of its member set, so the same id
  // recurs across windows whose underlying problem statements differ. Without
  // this filter a 90-day recommendation would be served for a 180-day run.
  const priorOutputs = (await loadPriorRecommendations()).filter(
    (output) => output.metadata.reportInputFile === reportInput.relativePath,
  );
  const priorIndex = buildPriorRecommendationIndex(priorOutputs);
  console.log(
    `✓ resumability scoped to ${priorOutputs.length} prior run(s) over ${reportInput.relativePath}`,
  );
  console.log("");

  console.log("Recommendations");
  console.log("");
  const { results, redactionsApplied } = await runRecommendations({
    issues,
    parseFn,
    model,
    promptVersion: ISSUE_RECOMMENDATION_PROMPT_VERSION,
    priorIndex,
    onProgress: printProgress,
  });

  const createdAt = new Date();
  const counts = countRecommendations(results);
  const failures = results.filter((result) => result.status === "failed").length;
  const windowTag =
    reportInput.windowTag ??
    (typeof reportOutput.metadata.sourceWindowDays === "number"
      ? windowTagForDays(reportOutput.metadata.sourceWindowDays)
      : null);

  const output: RecommendationOutput = {
    metadata: {
      reportInputFile: reportInput.relativePath,
      createdAt: createdAt.toISOString(),
      model,
      promptVersion: ISSUE_RECOMMENDATION_PROMPT_VERSION,
      ...(typeof reportOutput.metadata.sourceWindowDays === "number"
        ? { sourceWindowDays: reportOutput.metadata.sourceWindowDays }
        : {}),
      recurringIssuesAvailable: allIssues.length,
      analysed: results.length - failures,
      failures,
      ...counts,
      redactionsApplied,
    },
    results,
  };

  const outputFilePath = recommendationOutputFilePath(INTELLIGENCE_DATA_DIR, createdAt, windowTag);
  await writeRecommendationOutput(output, outputFilePath);

  console.log("");
  console.log("Results");
  console.log(`✓ ${results.length - failures} successful`);
  console.log(`✓ ${failures} failed`);
  console.log("");
  printCounts("Priority", counts.priorityCounts);
  printCounts("Automation opportunity", counts.automationOpportunityCounts);
  printCounts("Recommended action", counts.actionCounts);

  if (redactionsApplied > 0) {
    console.log(`⚠ ${redactionsApplied} identifier-shaped tokens were redacted before sending to Claude.`);
    console.log("  Worth checking why identifiers reached the extraction output.");
    console.log("");
  }

  console.log("Output");
  console.log(`✓ ${path.relative(process.cwd(), outputFilePath)}`);
  console.log("");
  console.log("Only de-identified structured issue evidence was sent to Claude.");
  console.log("Nothing was posted to Slack.");
}

main().catch((err: unknown) => {
  fail(`✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});
