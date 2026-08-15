import fs from "node:fs/promises";
import path from "node:path";
import { buildExtractionIndex } from "../adjudication/candidatePairs.js";
import { buildRecurringIssueGroups } from "../groups/buildGroups.js";
import type { AdjudicationOutput } from "../persistence/adjudicationOutput.js";
import { windowTagForDays } from "../persistence/datedFiles.js";
import { filePrefixesFor } from "../categories.js";
import type { ExtractionOutput } from "../persistence/extractionOutput.js";
import { groupOutputFilePath, writeGroupOutput, type GroupOutput } from "../persistence/groupOutput.js";
import { describeInputSelection, InputResolutionError, resolveInputFile } from "../persistence/resolveInput.js";
import { parseGroupsArgs } from "./groupsArgs.js";

const INTELLIGENCE_DATA_DIR = path.resolve(process.cwd(), "data", "intelligence");

function fail(message: string): never {
  console.error(message);
  console.log("");
  console.log("Recurring issue grouping failed.");
  process.exit(1);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function main() {
  const args = parseGroupsArgs(process.argv.slice(2));
  const prefixes = filePrefixesFor(args.category);

  let adjudicationInput;
  let extractionInput;
  try {
    adjudicationInput = await resolveInputFile({
      explicitInput: args.input,
      defaultDir: INTELLIGENCE_DATA_DIR,
      prefix: prefixes.adjudications,
      missingHint: "Run `npm run intelligence:adjudicate` first, or pass --input=<path>.",
    });
    extractionInput = await resolveInputFile({
      explicitInput: args.extractions,
      defaultDir: INTELLIGENCE_DATA_DIR,
      prefix: "extractions",
      missingHint: "Run `npm run intelligence:extract` first, or pass --extractions=<path>.",
    });
  } catch (err) {
    if (err instanceof InputResolutionError) {
      fail(`✗ ${err.message}`);
    }
    throw err;
  }

  let adjudication: AdjudicationOutput;
  let extraction: ExtractionOutput;
  try {
    adjudication = await readJsonFile<AdjudicationOutput>(adjudicationInput.absolutePath);
    extraction = await readJsonFile<ExtractionOutput>(extractionInput.absolutePath);
  } catch (err) {
    fail(`✗ Failed to read input files: ${err instanceof Error ? err.message : String(err)}`);
  }

  const extractionIndex = buildExtractionIndex(extraction);
  const { groups, stats } = buildRecurringIssueGroups(adjudication.results, extractionIndex);
  const adjudicatedPairs = adjudication.results.filter((r) => r.status === "success").length;

  console.log(`Escalation Intelligence — Recurring Issue Groups${args.dryRun ? " (dry run)" : ""}`);
  console.log("");
  console.log("Input");
  for (const line of describeInputSelection(adjudicationInput)) {
    console.log(line);
  }
  for (const line of describeInputSelection(extractionInput)) {
    console.log(line);
  }
  console.log(`✓ ${adjudicatedPairs} adjudicated candidate pairs`);
  console.log(`✓ ${stats.sameEdges} SAME edges`);
  console.log(`✓ ${stats.relatedEdges} RELATED edges`);
  console.log(`✓ ${stats.differentEdges} DIFFERENT edges`);
  console.log("");

  console.log("Graph");
  console.log(`✓ ${stats.candidateComponents} candidate connected components`);
  console.log(`✓ ${stats.recurringGroups} recurring groups`);
  console.log(`✓ ${stats.conflictedComponents} conflicted components`);
  console.log(`✓ ${stats.overlappingGroups} overlapping groups`);

  const needingReview = groups.filter((g) => g.consistency !== "fully_confirmed");
  if (needingReview.length > 0) {
    console.log(`⚠ ${needingReview.length} groups need review (incomplete or conflicted pair evidence)`);
  }
  for (const overlap of stats.overlappingMembers) {
    console.log(`⚠ ${overlap.member} appears in ${overlap.groupIds.length} groups: ${overlap.groupIds.join(", ")}`);
  }
  console.log("");

  console.log("Recurring issues");
  console.log("");
  groups.forEach((group, index) => {
    console.log(`${index + 1}. ${group.name ?? "(no proposed name)"}`);
    console.log(`   occurrences: ${group.occurrenceCount}`);
    console.log(
      `   confidence:  avg ${group.averageSameEdgeConfidence.toFixed(2)} / min ${group.minimumSameEdgeConfidence.toFixed(2)}`,
    );
    console.log(
      `   similarity:  avg ${group.averageSameEdgeSimilarity.toFixed(3)} / min ${group.minimumSameEdgeSimilarity.toFixed(3)}`,
    );
    console.log(`   consistency: ${group.consistency}`);
    console.log(`   window:      ${group.firstSeen?.slice(0, 10) ?? "?"} → ${group.lastSeen?.slice(0, 10) ?? "?"}`);
    if (group.alternateNames.length > 0) {
      console.log(`   alternates:  ${group.alternateNames.length}`);
    }
    console.log("");
  });

  if (args.dryRun) {
    console.log("Safety");
    console.log("✓ Zero API calls made");
    console.log("✓ No output file written");
    return;
  }

  const createdAt = new Date();
  const windowTag =
    adjudicationInput.windowTag ??
    (typeof adjudication.metadata.sourceWindowDays === "number"
      ? windowTagForDays(adjudication.metadata.sourceWindowDays)
      : null);

  const output: GroupOutput = {
    metadata: {
      adjudicationInputFile: adjudicationInput.relativePath,
      extractionInputFile: extractionInput.relativePath,
      ...(typeof adjudication.metadata.sourceWindowDays === "number"
        ? { sourceWindowDays: adjudication.metadata.sourceWindowDays }
        : {}),
      createdAt: createdAt.toISOString(),
      adjudicationModel: adjudication.metadata.model,
      adjudicationPromptVersion: adjudication.metadata.promptVersion,
      candidateSimilarityFloor: adjudication.metadata.candidateSimilarityFloor,
      adjudicatedPairs,
      sameEdges: stats.sameEdges,
      relatedEdges: stats.relatedEdges,
      differentEdges: stats.differentEdges,
      candidateComponents: stats.candidateComponents,
      recurringGroups: stats.recurringGroups,
      conflictedComponents: stats.conflictedComponents,
      overlappingGroups: stats.overlappingGroups,
      overlappingMembers: stats.overlappingMembers,
      relatedPairCount: stats.relatedEdges,
      category: args.category,
    },
    groups,
  };

  const outputFilePath = groupOutputFilePath(INTELLIGENCE_DATA_DIR, createdAt, windowTag, prefixes.groups);
  await writeGroupOutput(output, outputFilePath);

  console.log("Output");
  console.log(`✓ ${path.relative(process.cwd(), outputFilePath)}`);
  console.log("");
  console.log("No API calls were made.");
  console.log("No Slack messages were posted.");
}

main().catch((err: unknown) => {
  fail(`✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});
