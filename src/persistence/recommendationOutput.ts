import fs from "node:fs/promises";
import path from "node:path";
import type {
  AutomationOpportunity,
  Priority,
  RecommendedAction,
} from "../llm/schemas/issueRecommendation.js";
import {
  AUTOMATION_OPPORTUNITIES,
  PRIORITIES,
  RECOMMENDED_ACTIONS,
} from "../llm/schemas/issueRecommendation.js";
import { buildDatedFilename } from "./datedFiles.js";

export interface RecommendationResultItem {
  groupId: string;
  name: string | null;
  occurrenceCount: number;
  /** Retained for rendering the eventual Slack report; never sent to the LLM. */
  permalinks: Array<{ rootTs: string; permalink: string | null }>;
  status: "success" | "failed";
  recommendedAction?: RecommendedAction;
  priority?: Priority;
  engineeringRecommendation?: string;
  rationale?: string;
  evidenceSummary?: string;
  automationOpportunity?: AutomationOpportunity;
  automationIdea?: string | null;
  confidence?: number;
  error?: string;
}

export type ActionCounts = Record<RecommendedAction, number>;
export type PriorityCounts = Record<Priority, number>;
export type AutomationCounts = Record<AutomationOpportunity, number>;

export interface RecommendationRunMetadata {
  reportInputFile: string;
  createdAt: string;
  model: string;
  promptVersion: string;
  sourceWindowDays?: number;
  recurringIssuesAvailable: number;
  analysed: number;
  failures: number;
  actionCounts: ActionCounts;
  priorityCounts: PriorityCounts;
  automationOpportunityCounts: AutomationCounts;
  /** Identifier-shaped tokens redacted while building outbound payloads. */
  redactionsApplied: number;
}

export interface RecommendationOutput {
  metadata: RecommendationRunMetadata;
  results: RecommendationResultItem[];
}

export function recommendationOutputFilePath(
  baseDir: string,
  createdAt: Date,
  windowTag?: string | null,
): string {
  return path.join(baseDir, buildDatedFilename("recommendations", createdAt, windowTag));
}

export async function writeRecommendationOutput(
  output: RecommendationOutput,
  filePath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}

function emptyCounts<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}

export const emptyActionCounts = (): ActionCounts => emptyCounts(RECOMMENDED_ACTIONS);
export const emptyPriorityCounts = (): PriorityCounts => emptyCounts(PRIORITIES);
export const emptyAutomationCounts = (): AutomationCounts => emptyCounts(AUTOMATION_OPPORTUNITIES);

export function countRecommendations(results: RecommendationResultItem[]): {
  actionCounts: ActionCounts;
  priorityCounts: PriorityCounts;
  automationOpportunityCounts: AutomationCounts;
} {
  const actionCounts = emptyActionCounts();
  const priorityCounts = emptyPriorityCounts();
  const automationOpportunityCounts = emptyAutomationCounts();

  for (const result of results) {
    if (result.status !== "success") {
      continue;
    }
    if (result.recommendedAction) {
      actionCounts[result.recommendedAction] += 1;
    }
    if (result.priority) {
      priorityCounts[result.priority] += 1;
    }
    if (result.automationOpportunity) {
      automationOpportunityCounts[result.automationOpportunity] += 1;
    }
  }

  return { actionCounts, priorityCounts, automationOpportunityCounts };
}

function priorKey(groupId: string, promptVersion: string, model: string): string {
  return `${groupId}::${promptVersion}::${model}`;
}

/**
 * Index of already-generated recommendations, keyed by groupId + prompt
 * version + model. Only successes are indexed, so a prior failure is always
 * retried; changing the prompt or the model produces no match and correctly
 * forces regeneration rather than reusing advice from a different author.
 */
export function buildPriorRecommendationIndex(
  priorOutputs: RecommendationOutput[],
): Map<string, RecommendationResultItem> {
  const index = new Map<string, RecommendationResultItem>();
  for (const output of priorOutputs) {
    for (const result of output.results) {
      if (result.status !== "success") {
        continue;
      }
      index.set(priorKey(result.groupId, output.metadata.promptVersion, output.metadata.model), result);
    }
  }
  return index;
}

export function lookupPriorRecommendation(
  index: Map<string, RecommendationResultItem>,
  groupId: string,
  promptVersion: string,
  model: string,
): RecommendationResultItem | undefined {
  return index.get(priorKey(groupId, promptVersion, model));
}
