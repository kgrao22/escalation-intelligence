import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import type { ExtractionOutput } from "../persistence/extractionOutput.js";
import { describeInputSelection, InputResolutionError, resolveInputFile } from "../persistence/resolveInput.js";
import {
  collectWorkflowSamples,
  computeWorkflowBreakdown,
  countWorkflowClassifications,
  describeFailedEnumFields,
} from "../workflow/workflowStats.js";

const INTELLIGENCE_DATA_DIR = path.resolve(process.cwd(), "data", "intelligence");

/** Manual validation aid. Reads one local file and prints. Zero API calls, ever. */
function fail(message: string): never {
  console.error(message);
  console.log("");
  console.log("Workflow summary failed.");
  process.exit(1);
}

interface WorkflowSummaryArgs {
  input?: string;
  limit: number;
}

export function parseWorkflowSummaryArgs(argv: string[]): WorkflowSummaryArgs {
  const { values } = parseArgs({
    args: argv,
    options: { input: { type: "string" }, limit: { type: "string" } },
    strict: false,
  });

  let limit = 20;
  if (values.limit !== undefined) {
    const parsed = Number.parseInt(String(values.limit), 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`Invalid --limit value: "${values.limit}". Must be a positive integer.`);
    }
    limit = parsed;
  }

  return { input: values.input !== undefined ? String(values.input) : undefined, limit };
}

async function main() {
  let args;
  try {
    args = parseWorkflowSummaryArgs(process.argv.slice(2));
  } catch (err) {
    fail(`✗ ${err instanceof Error ? err.message : String(err)}`);
  }

  let resolvedInput;
  try {
    resolvedInput = await resolveInputFile({
      explicitInput: args.input,
      defaultDir: INTELLIGENCE_DATA_DIR,
      prefix: "extractions",
      missingHint: "Run `npm run intelligence:extract` first, or pass --input=<path>.",
    });
  } catch (err) {
    if (err instanceof InputResolutionError) {
      fail(`✗ ${err.message}`);
    }
    throw err;
  }

  let extraction: ExtractionOutput;
  try {
    extraction = JSON.parse(await fs.readFile(resolvedInput.absolutePath, "utf8")) as ExtractionOutput;
    if (!Array.isArray(extraction.results)) {
      throw new Error("missing or invalid `results` array");
    }
  } catch (err) {
    fail(`✗ Failed to read ${resolvedInput.relativePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const breakdown = computeWorkflowBreakdown(extraction.results);
  const types = countWorkflowClassifications(extraction.results);
  const samples = collectWorkflowSamples(extraction.results, args.limit);

  console.log("Escalation Intelligence — Workflow Summary");
  console.log("");
  console.log("Input");
  for (const line of describeInputSelection(resolvedInput)) {
    console.log(line);
  }
  console.log(`✓ prompt version: ${extraction.metadata.promptVersion}${extraction.metadata.promptRevision ? ` (${extraction.metadata.promptRevision})` : ""}`);
  console.log(`✓ model: ${extraction.metadata.model}`);
  console.log("");

  console.log("Totals");
  console.log(`✓ ${breakdown.analysed} successful extractions`);
  console.log(`✓ ${breakdown.workflowCandidates} automation workflow candidates`);
  console.log(`✓ ${breakdown.nonWorkflow} non-workflow threads`);
  console.log(`✓ ${breakdown.technicalAndWorkflow} technical + workflow`);
  console.log(`✓ ${breakdown.workflowOnly} workflow-only`);
  console.log(`✓ ${breakdown.technicalOnly} technical-only`);
  console.log(`✓ ${breakdown.neither} neither`);
  if (breakdown.failed > 0) {
    console.log(`⚠ ${breakdown.failed} failed extractions are excluded from every bucket above`);
    for (const result of extraction.results.filter((r) => r.status === "failed")) {
      const fields = describeFailedEnumFields(result.error);
      console.log(`    ${result.rootTs} — ${fields.length > 0 ? `invalid enum: ${fields.join(", ")}` : "non-enum failure"}`);
    }
  }
  console.log("");

  console.log("Workflow types");
  const typeWidth = Math.max(...Object.keys(types).map((key) => key.length));
  for (const [type, count] of Object.entries(types)) {
    console.log(`  ${type.padEnd(typeWidth)}  ${count}`);
  }
  console.log("");

  console.log(`Sample workflow statements (most recent ${samples.length})`);
  console.log("");
  samples.forEach((sample, index) => {
    console.log(`${index + 1}. [${sample.nature}] ${sample.workflowClassification ?? "(unclassified)"} — ${sample.automationStatus}`);
    console.log(`   ${sample.normalizedWorkflowStatement}`);
    console.log(`   rootTs: ${sample.rootTs}`);
    console.log(`   link:   ${sample.permalink ?? "(no permalink)"}`);
    console.log("");
  });

  console.log("No API calls were made.");
  console.log("Nothing was posted to Slack.");
}

main().catch((err: unknown) => {
  fail(`✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});
