import { WORKFLOW_CLASSIFICATIONS } from "../llm/schemas/escalationAnalysis.js";
import type { ExtractionResultItem } from "../persistence/extractionOutput.js";

/**
 * The two judgements are independent, so the honest summary is the full 2x2,
 * not two separate percentages. Buckets are computed over SUCCESSFUL results
 * only — a failed extraction has no analysis and must never be silently
 * counted as "neither", which would understate workflow prevalence.
 */
export interface WorkflowBreakdown {
  analysed: number;
  failed: number;
  technical: number;
  nonTechnical: number;
  workflowCandidates: number;
  nonWorkflow: number;
  technicalAndWorkflow: number;
  workflowOnly: number;
  technicalOnly: number;
  neither: number;
}

function successes(results: ExtractionResultItem[]) {
  return results.filter((result) => result.status === "success" && result.analysis !== undefined);
}

export function computeWorkflowBreakdown(results: ExtractionResultItem[]): WorkflowBreakdown {
  const ok = successes(results);
  const technicalAndWorkflow = ok.filter(
    (r) => r.analysis?.isTechnicalEscalation && r.analysis.isAutomationWorkflowCandidate,
  ).length;
  const workflowOnly = ok.filter(
    (r) => !r.analysis?.isTechnicalEscalation && r.analysis?.isAutomationWorkflowCandidate,
  ).length;
  const technicalOnly = ok.filter(
    (r) => r.analysis?.isTechnicalEscalation && !r.analysis.isAutomationWorkflowCandidate,
  ).length;
  const neither = ok.filter(
    (r) => !r.analysis?.isTechnicalEscalation && !r.analysis?.isAutomationWorkflowCandidate,
  ).length;

  return {
    analysed: ok.length,
    failed: results.filter((result) => result.status === "failed").length,
    technical: technicalAndWorkflow + technicalOnly,
    nonTechnical: workflowOnly + neither,
    workflowCandidates: technicalAndWorkflow + workflowOnly,
    nonWorkflow: technicalOnly + neither,
    technicalAndWorkflow,
    workflowOnly,
    technicalOnly,
    neither,
  };
}

export type WorkflowClassificationCounts = Record<string, number>;

/**
 * Every known classification is present and zeroed, so a shape that never
 * appears is visibly absent rather than missing from the output entirely.
 */
export function countWorkflowClassifications(results: ExtractionResultItem[]): WorkflowClassificationCounts {
  const counts: WorkflowClassificationCounts = {};
  for (const classification of WORKFLOW_CLASSIFICATIONS) {
    counts[classification] = 0;
  }
  for (const result of successes(results)) {
    const classification = result.analysis?.workflowClassification;
    if (result.analysis?.isAutomationWorkflowCandidate && typeof classification === "string") {
      counts[classification] = (counts[classification] ?? 0) + 1;
    }
  }
  return counts;
}

export interface WorkflowSample {
  rootTs: string;
  permalink: string | null;
  normalizedWorkflowStatement: string;
  workflowClassification: string | null;
  automationStatus: string;
  /** Which of the 2x2 quadrants this sample sits in. */
  nature: "technical+workflow" | "workflow-only";
}

/**
 * Ordered most-recent-first (rootTs is a Slack epoch timestamp), so a manual
 * reviewer sees current work rather than whatever happened to be first in the
 * file. `limit` of 0 or less returns everything.
 */
export function collectWorkflowSamples(results: ExtractionResultItem[], limit = 20): WorkflowSample[] {
  const samples = successes(results)
    .filter((result) => result.analysis?.isAutomationWorkflowCandidate)
    .map((result): WorkflowSample => {
      const analysis = result.analysis!;
      return {
        rootTs: result.rootTs,
        permalink: analysis.permalink ?? null,
        normalizedWorkflowStatement: analysis.normalizedWorkflowStatement ?? "(none)",
        workflowClassification: analysis.workflowClassification ?? null,
        automationStatus: analysis.automationStatus,
        nature: analysis.isTechnicalEscalation ? "technical+workflow" : "workflow-only",
      };
    })
    .sort((a, b) => Number(b.rootTs) - Number(a.rootTs));

  return limit > 0 ? samples.slice(0, limit) : samples;
}

/**
 * Pulls the field names out of a structured-output validation failure so a
 * retry run can say which enums the model got wrong, instead of printing a
 * wall of Zod output. Returns [] for failures of any other kind.
 */
export function describeFailedEnumFields(errorMessage: string | undefined): string[] {
  if (!errorMessage) {
    return [];
  }
  const fields = new Set<string>();
  // Matches the `"path": [ "fieldName" ]` blocks in the serialised Zod issues.
  const pathPattern = /"path"\s*:\s*\[\s*"([^"]+)"/g;
  for (const match of errorMessage.matchAll(pathPattern)) {
    if (match[1]) {
      fields.add(match[1]);
    }
  }
  // Older/simpler failures render as "  - fieldName: Invalid option".
  const linePattern = /^\s*-\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*Invalid option/gm;
  for (const match of errorMessage.matchAll(linePattern)) {
    if (match[1]) {
      fields.add(match[1]);
    }
  }
  return [...fields].sort();
}
