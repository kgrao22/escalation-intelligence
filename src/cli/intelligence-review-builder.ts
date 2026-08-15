import fs from "node:fs/promises";
import path from "node:path";
import type { ExtractionOutput } from "../persistence/extractionOutput.js";
import type { ReportOutput } from "../persistence/reportOutput.js";
import {
  reviewArtifactFilePath,
  writeReviewArtifact,
  type ReviewArtifact,
} from "../persistence/reviewArtifactOutput.js";
import type { WorkflowClusterOutput } from "../persistence/workflowClusterOutput.js";
import type { WorkflowRecommendationOutput } from "../persistence/workflowRecommendationOutput.js";
import { parseDatedFilename, pickLatestDatedFilename } from "../persistence/datedFiles.js";
import { buildReview, ReviewIntegrityError } from "../review/buildReview.js";
import { renderReview } from "../review/renderReview.js";
import { parseReviewBuilderArgs } from "./reviewBuilderArgs.js";

const INTELLIGENCE_DATA_DIR = path.resolve(process.cwd(), "data", "intelligence");

function fail(message: string): never {
  console.error(message);
  console.log("");
  console.log("Review generation failed.");
  process.exit(1);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

/**
 * Explicit paths always win. Auto-resolution is restricted to the requested
 * window, so a 90-day file can never be picked up for a 180-day review.
 */
async function resolveByWindow(
  explicit: string | undefined,
  prefix: string,
  windowTag: string,
): Promise<{ absolutePath: string; relativePath: string } | undefined> {
  if (explicit) {
    const absolutePath = path.resolve(process.cwd(), explicit);
    return { absolutePath, relativePath: path.relative(process.cwd(), absolutePath) };
  }

  let filenames: string[];
  try {
    filenames = await fs.readdir(INTELLIGENCE_DATA_DIR);
  } catch {
    return undefined;
  }

  // Delegate to the shared resolver so versioned artifacts (`-v2-`) are
  // understood and always beat the superseded generation they replace.
  const chosen = pickLatestDatedFilename(
    filenames.filter((name) => parseDatedFilename(name, prefix)?.windowTag === windowTag),
    prefix,
  );
  if (!chosen) {
    return undefined;
  }
  const absolutePath = path.join(INTELLIGENCE_DATA_DIR, chosen);
  return { absolutePath, relativePath: path.relative(process.cwd(), absolutePath) };
}

async function main() {
  let args;
  try {
    args = parseReviewBuilderArgs(process.argv.slice(2));
  } catch (err) {
    fail(`✗ ${err instanceof Error ? err.message : String(err)}`);
  }

  const extractionsInput = await resolveByWindow(args.extractions, "extractions", args.window);
  const clustersInput = await resolveByWindow(args.workflowClusters, "workflow-clusters", args.window);
  const recommendationsInput = await resolveByWindow(
    args.workflowRecommendations,
    "workflow-recommendations",
    args.window,
  );

  const missing = [
    ["extractions", extractionsInput],
    ["workflow clusters", clustersInput],
    ["workflow recommendations", recommendationsInput],
  ].filter(([, resolved]) => resolved === undefined);
  if (missing.length > 0 || !extractionsInput || !clustersInput || !recommendationsInput) {
    fail(
      `✗ Could not resolve required ${args.window} inputs: ${missing.map(([label]) => label as string).join(", ")}.\n` +
        "  Pass explicit paths, or run the workflow pipeline for this window first.",
    );
  }

  // Technical recurrence is OPTIONAL. It is only auto-resolved for the exact
  // review window — a shorter window's report is never picked up implicitly.
  const technicalInput = await resolveByWindow(args.technicalReport, "report", args.window);
  const technicalRecInput = await resolveByWindow(
    args.technicalRecommendations,
    "recommendations",
    args.window,
  );

  let extraction: ExtractionOutput;
  let clusters: WorkflowClusterOutput;
  let recommendations: WorkflowRecommendationOutput;
  let technicalReport: ReportOutput | undefined;
  let technicalRemediation: Map<string, string> | undefined;
  try {
    extraction = await readJsonFile<ExtractionOutput>(extractionsInput.absolutePath);
    clusters = await readJsonFile<WorkflowClusterOutput>(clustersInput.absolutePath);
    recommendations = await readJsonFile<WorkflowRecommendationOutput>(recommendationsInput.absolutePath);
    if (technicalInput) {
      technicalReport = await readJsonFile<ReportOutput>(technicalInput.absolutePath);
    }
    if (technicalRecInput) {
      const parsed = await readJsonFile<{
        metadata: { reportInputFile?: string };
        results: Array<{ groupId: string; engineeringRecommendation?: string }>;
      }>(technicalRecInput.absolutePath);
      // Only adopt them when they were generated from THIS report.
      if (technicalInput && parsed.metadata.reportInputFile === technicalInput.relativePath) {
        technicalRemediation = new Map(
          parsed.results
            .filter((r) => typeof r.engineeringRecommendation === "string")
            .map((r) => [r.groupId, r.engineeringRecommendation as string]),
        );
      } else {
        console.log("⚠ technical recommendations do not trace to the resolved report — remediation omitted");
      }
    }
  } catch (err) {
    fail(`✗ Failed to read input files: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Guard against mixing artifact generations. Recommendations must trace back
  // to the very report/cluster files this review is being built from.
  const generationOf = (relativePath: string, prefix: string): number =>
    parseDatedFilename(path.basename(relativePath), prefix)?.generation ?? 1;

  const technicalGeneration = technicalInput ? generationOf(technicalInput.relativePath, "report") : null;
  const clusterGeneration = generationOf(clustersInput.relativePath, "workflow-clusters");
  const recommendationSource = recommendations.metadata.inputFile;
  if (recommendationSource !== clustersInput.relativePath) {
    fail(
      `✗ Workflow recommendations were generated from ${recommendationSource}, but this review resolved ` +
        `${clustersInput.relativePath}. Refusing to mix artifact generations.`,
    );
  }
  if (technicalGeneration !== null && clusterGeneration !== technicalGeneration) {
    console.log(
      `⚠ technical report is generation v${technicalGeneration} and workflow clusters are v${clusterGeneration}`,
    );
  }

  let review;
  try {
    review = buildReview({
      windowTag: args.window,
      extraction,
      clusters,
      recommendations,
      technicalReport,
      technicalRemediation,
    });
  } catch (err) {
    if (err instanceof ReviewIntegrityError) {
      fail(`✗ ${err.message}\n  No review was written.`);
    }
    throw err;
  }

  const rendered = renderReview(review);

  console.log(`Escalation Intelligence — Review Builder${args.dryRun ? " (dry run)" : ""}`);
  console.log("");
  console.log("Resolved inputs");
  console.log(`✓ window: ${args.window}`);
  console.log(`✓ extractions:              ${extractionsInput.relativePath}`);
  console.log(`✓ workflow clusters:        ${clustersInput.relativePath}`);
  console.log(`✓ workflow recommendations: ${recommendationsInput.relativePath}`);
  if (technicalInput) {
    console.log(`✓ technical report:         ${technicalInput.relativePath}`);
  } else {
    console.log(`⚠ technical report:         none found for ${args.window} — section will say so explicitly`);
  }
  console.log(`✓ workflow recommendations trace to: ${recommendationSource}`);
  if (technicalRecInput) {
    console.log(`✓ technical recommendations:  ${technicalRecInput.relativePath}`);
  }
  console.log("");
  console.log(
    `Technical recurrence: ${review.technicalIssues.available ? "available" : "NOT AVAILABLE for this window"}`,
  );
  console.log("");

  console.log("Integrity");
  console.log(`✓ ${review.automationOpportunities.length} recommendations cross-validated against clusters`);
  console.log("✓ ranks unique and contiguous; occurrence counts agree");
  console.log("✓ evidence links belong to their own cluster");
  console.log(
    `✓ technical+workflow counted once (${review.overview.distinctActionableThreads} distinct actionable threads)`,
  );
  console.log("");

  console.log("─".repeat(72));
  console.log("SLACK PREVIEW — top-level message");
  console.log("─".repeat(72));
  console.log(rendered.slackMrkdwn.overview);
  for (const [index, reply] of rendered.slackMrkdwn.replies.entries()) {
    console.log("");
    console.log("─".repeat(72));
    console.log(`SLACK PREVIEW — thread reply ${index + 1}: ${reply.title}`);
    console.log("─".repeat(72));
    console.log(reply.text);
  }
  console.log("");

  if (args.dryRun) {
    console.log("Safety");
    console.log("✓ Zero external API calls (Slack, Anthropic, Voyage)");
    console.log("✓ No output file written");
    console.log("✓ Nothing was posted to Slack");
    return;
  }

  const generatedAt = new Date();
  const artifact: ReviewArtifact = {
    metadata: {
      windowTag: args.window,
      generatedAt: generatedAt.toISOString(),
      extractionsInputFile: extractionsInput.relativePath,
      workflowClustersInputFile: clustersInput.relativePath,
      workflowRecommendationsInputFile: recommendationsInput.relativePath,
      technicalReportInputFile: technicalInput?.relativePath ?? null,
      technicalRecurrenceAvailable: review.technicalIssues.available,
      externalApiCalls: 0,
    },
    overview: review.overview,
    automationOpportunities: review.automationOpportunities,
    recurringWorkflows: review.recurringWorkflows,
    technicalIssues: review.technicalIssues,
    longTail: review.longTail,
    nextActions: review.nextActions,
    rendered,
  };

  const outputFilePath = reviewArtifactFilePath(INTELLIGENCE_DATA_DIR, generatedAt, args.window);
  await writeReviewArtifact(artifact, outputFilePath);

  console.log("Output");
  console.log(`✓ ${path.relative(process.cwd(), outputFilePath)}`);
  console.log("");
  console.log("No external API calls were made.");
  console.log("Nothing was posted to Slack.");
}

main().catch((err: unknown) => {
  fail(`✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});
