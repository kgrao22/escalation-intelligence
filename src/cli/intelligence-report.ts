import fs from "node:fs/promises";
import path from "node:path";
import { windowTagForDays } from "../persistence/datedFiles.js";
import type { GroupOutput } from "../persistence/groupOutput.js";
import { reportOutputFilePath, writeReportOutput, type ReportOutput } from "../persistence/reportOutput.js";
import { describeInputSelection, InputResolutionError, resolveInputFile } from "../persistence/resolveInput.js";
import { buildRecurringIssueReport } from "../report/buildReport.js";
import { buildRecurringWorkflowReport } from "../report/buildWorkflowReport.js";
import type { DistributionEntry } from "../report/distributions.js";
import { parseReportArgs } from "./reportArgs.js";

const INTELLIGENCE_DATA_DIR = path.resolve(process.cwd(), "data", "intelligence");

function fail(message: string): never {
  console.error(message);
  console.log("");
  console.log("Recurring issue report failed.");
  process.exit(1);
}

/** Renders only non-zero buckets, in canonical order, e.g. "high 2, medium 1". */
function formatDistribution<T extends string>(entries: Array<DistributionEntry<T>>): string {
  const populated = entries.filter((entry) => entry.count > 0);
  return populated.length === 0 ? "—" : populated.map((entry) => `${entry.value} ${entry.count}`).join(", ");
}

function formatDays(value: number | null, suffix = "d"): string {
  return value === null ? "?" : `${Number.isInteger(value) ? value : value.toFixed(1)}${suffix}`;
}

async function main() {
  const args = parseReportArgs(process.argv.slice(2));

  let groupsInput;
  try {
    groupsInput = await resolveInputFile({
      explicitInput: args.input,
      defaultDir: INTELLIGENCE_DATA_DIR,
      prefix: "groups",
      missingHint: "Run `npm run intelligence:groups` first, or pass --input=<path>.",
    });
  } catch (err) {
    if (err instanceof InputResolutionError) {
      fail(`✗ ${err.message}`);
    }
    throw err;
  }

  let groupOutput: GroupOutput;
  try {
    groupOutput = JSON.parse(await fs.readFile(groupsInput.absolutePath, "utf8")) as GroupOutput;
    if (!Array.isArray(groupOutput.groups)) {
      throw new Error("missing or invalid `groups` array");
    }
  } catch (err) {
    fail(`✗ Failed to read ${groupsInput.relativePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The workflow track is optional: a repo that has only ever run the technical
  // pipeline still produces a valid, unchanged report.
  let workflowGroupsInput;
  try {
    workflowGroupsInput = await resolveInputFile({
      explicitInput: args.workflowGroups,
      defaultDir: INTELLIGENCE_DATA_DIR,
      prefix: "workflow-groups",
      missingHint: "Run `npm run intelligence:groups -- --category=workflow` to add the workflow section.",
    });
  } catch (err) {
    if (err instanceof InputResolutionError) {
      // Only an explicitly requested file is worth failing over.
      if (args.workflowGroups !== undefined) {
        fail(`✗ ${err.message}`);
      }
      workflowGroupsInput = undefined;
    } else {
      throw err;
    }
  }

  let workflowGroupOutput: GroupOutput | undefined;
  if (workflowGroupsInput) {
    try {
      workflowGroupOutput = JSON.parse(await fs.readFile(workflowGroupsInput.absolutePath, "utf8")) as GroupOutput;
      if (!Array.isArray(workflowGroupOutput.groups)) {
        throw new Error("missing or invalid `groups` array");
      }
    } catch (err) {
      fail(
        `✗ Failed to read ${workflowGroupsInput.relativePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const createdAt = new Date();
  const report = buildRecurringIssueReport(groupOutput, createdAt);
  const workflowReport = workflowGroupOutput
    ? buildRecurringWorkflowReport(workflowGroupOutput, createdAt)
    : undefined;
  const { summary } = report;

  console.log(`Escalation Intelligence — Recurring Issue Report${args.dryRun ? " (dry run)" : ""}`);
  console.log("");
  console.log("Input");
  for (const line of describeInputSelection(groupsInput)) {
    console.log(line);
  }
  console.log("");

  if (workflowGroupsInput) {
    for (const line of describeInputSelection(workflowGroupsInput)) {
      console.log(line);
    }
    console.log("");
  }

  console.log("SECTION 1 — RECURRING TECHNICAL ISSUES");
  console.log("");
  console.log("Summary");
  console.log(`✓ ${summary.recurringIssueCount} recurring issues`);
  console.log(`✓ ${summary.totalOccurrences} total occurrences`);
  console.log(`✓ ${summary.issuesWithOpenOccurrences} issues with unresolved or workaround occurrences`);
  console.log(`✓ ${summary.totalOpenOccurrences} open occurrences overall`);
  console.log(`✓ largest recurring issue: ${summary.largestGroupSize} occurrences`);
  console.log(
    `✓ window: ${summary.earliestOccurrence?.slice(0, 10) ?? "?"} → ${summary.latestOccurrence?.slice(0, 10) ?? "?"}`,
  );
  if (summary.issuesNeedingReview > 0) {
    console.log(`⚠ ${summary.issuesNeedingReview} issues need review (incomplete or conflicted pair evidence)`);
  }
  console.log("");
  console.log(`  severity:   ${formatDistribution(summary.severityDistribution)}`);
  console.log(`  impact:     ${formatDistribution(summary.customerImpactDistribution)}`);
  console.log(`  resolution: ${formatDistribution(summary.resolutionStatusDistribution)}`);
  console.log("");

  console.log("Ranked recurring issues");
  console.log("(ordering is tiered, not a score — see rankingCriteria in the output)");
  console.log("");

  for (const issue of report.issues) {
    const openFlag = issue.resolution.hasOpenOccurrences ? "  ⚠ OPEN" : "";
    const reviewFlag = issue.needsReview ? `  ⚠ ${issue.consistency}` : "";
    console.log(`${issue.rank}. ${issue.name ?? "(no proposed name)"}${openFlag}${reviewFlag}`);
    console.log(`   occurrences: ${issue.occurrenceCount}`);
    console.log(`   severity:    ${formatDistribution(issue.severityDistribution)}`);
    console.log(`   impact:      ${formatDistribution(issue.customerImpactDistribution)}`);
    console.log(`   resolution:  ${formatDistribution(issue.resolutionStatusDistribution)}`);
    console.log(
      `   recurrence:  ${issue.window.firstSeen?.slice(0, 10) ?? "?"} → ${issue.window.lastSeen?.slice(0, 10) ?? "?"}` +
        ` (span ${formatDays(issue.window.spanDays)}, avg gap ${formatDays(issue.window.averageDaysBetweenOccurrences)},` +
        ` last seen ${formatDays(issue.window.daysSinceLastOccurrence)} ago)`,
    );
    if (issue.affectedSystems.length > 0) {
      console.log(`   systems:     ${issue.affectedSystems.join(", ")}`);
    }
    console.log("");
  }

  if (workflowReport) {
    const w = workflowReport.summary;
    console.log("SECTION 2 — RECURRING MANUAL OPERATIONAL WORKFLOWS");
    console.log("(counted separately from technical defects — never summed with Section 1)");
    console.log("");
    console.log("Summary");
    console.log(`✓ ${w.recurringWorkflowCount} recurring manual workflows`);
    console.log(`✓ ${w.totalOccurrences} total manual requests`);
    console.log(`✓ ${w.fullyManualWorkflowCount} workflows still fully manual`);
    console.log(`✓ largest recurring workflow: ${w.largestWorkflowSize} requests`);
    console.log(
      `✓ window: ${w.earliestOccurrence?.slice(0, 10) ?? "?"} → ${w.latestOccurrence?.slice(0, 10) ?? "?"}`,
    );
    if (w.workflowsNeedingReview > 0) {
      console.log(`⚠ ${w.workflowsNeedingReview} workflows need review (incomplete or conflicted pair evidence)`);
    }
    console.log("");
    console.log(`  automation: ${formatDistribution(w.automationStatusDistribution)}`);
    console.log("");

    console.log("Ranked recurring manual workflows");
    console.log("(ordering is tiered, not a score — see workflowReport.rankingCriteria)");
    console.log("");

    workflowReport.workflows.forEach((workflow, index) => {
      const reviewFlag = workflow.needsReview ? `  ⚠ ${workflow.consistency}` : "";
      console.log(`${index + 1}. ${workflow.name ?? "(no proposed name)"}${reviewFlag}`);
      console.log(`   requests:   ${workflow.occurrenceCount}`);
      console.log(`   automation: ${workflow.predominantAutomationStatus}`);
      console.log(
        `   recurrence: ${workflow.firstSeen?.slice(0, 10) ?? "?"} → ${workflow.lastSeen?.slice(0, 10) ?? "?"}` +
          ` (span ${formatDays(workflow.spanDays)}, avg gap ${formatDays(workflow.averageDaysBetweenOccurrences)},` +
          ` last seen ${formatDays(workflow.daysSinceLastOccurrence)} ago)`,
      );
      if (workflow.workflowClassifications.length > 0) {
        console.log(`   types:      ${workflow.workflowClassifications.join(", ")}`);
      }
      if (workflow.affectedSystems.length > 0) {
        console.log(`   systems:    ${workflow.affectedSystems.join(", ")}`);
      }
      for (const occurrence of workflow.occurrences) {
        if (occurrence.permalink) {
          console.log(`   evidence:   ${occurrence.permalink}`);
        }
      }
      console.log("");
    });
  } else {
    console.log("SECTION 2 — RECURRING MANUAL OPERATIONAL WORKFLOWS");
    console.log("(skipped — no workflow-groups-*.json found)");
    console.log("");
  }

  if (args.dryRun) {
    console.log("Safety");
    console.log("✓ Zero API calls made");
    console.log("✓ No output file written");
    console.log("✓ Nothing posted to Slack");
    return;
  }

  const windowTag =
    groupsInput.windowTag ??
    (typeof groupOutput.metadata.sourceWindowDays === "number"
      ? windowTagForDays(groupOutput.metadata.sourceWindowDays)
      : null);

  const output: ReportOutput = {
    metadata: {
      groupsInputFile: groupsInput.relativePath,
      createdAt: createdAt.toISOString(),
      asOf: createdAt.toISOString(),
      ...(typeof groupOutput.metadata.sourceWindowDays === "number"
        ? { sourceWindowDays: groupOutput.metadata.sourceWindowDays }
        : {}),
      adjudicationModel: groupOutput.metadata.adjudicationModel,
      adjudicationPromptVersion: groupOutput.metadata.adjudicationPromptVersion,
      candidateSimilarityFloor: groupOutput.metadata.candidateSimilarityFloor,
      ...(workflowGroupsInput ? { workflowGroupsInputFile: workflowGroupsInput.relativePath } : {}),
    },
    report,
    ...(workflowReport ? { workflowReport } : {}),
  };

  const outputFilePath = reportOutputFilePath(INTELLIGENCE_DATA_DIR, createdAt, windowTag);
  await writeReportOutput(output, outputFilePath);

  console.log("Output");
  console.log(`✓ ${path.relative(process.cwd(), outputFilePath)}`);
  console.log("");
  console.log("No API calls were made.");
  console.log("Nothing was posted to Slack.");
}

main().catch((err: unknown) => {
  fail(`✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});
