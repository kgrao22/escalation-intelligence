import fs from "node:fs/promises";
import path from "node:path";
import type {
  AutomationFeasibility,
  AutomationPriority,
  RecommendedAction,
} from "../llm/schemas/workflowRecommendation.js";
import type { ScoringBreakdown } from "../workflow/workflowScoring.js";
import { buildDatedFilename } from "./datedFiles.js";

export interface WorkflowRecommendationItem {
  rank: number;
  clusterId: string;
  occurrenceCount: number;
  representativeWorkflowStatement: string;
  baseScore: number;
  scoringBreakdown: ScoringBreakdown;
  dominantWorkflowClassification: string | null;
  automationStatusBreakdown: Record<string, number>;
  firstSeen: string | null;
  lastSeen: string | null;
  /** Local metadata, reattached after the model responded. Never transmitted. */
  memberRootTs: string[];
  samplePermalinks: string[];
  relatedClusterIds: string[];
  status: "success" | "failed";
  recommendedAction?: RecommendedAction;
  automationPriority?: AutomationPriority;
  automationFeasibility?: AutomationFeasibility;
  rationale?: string;
  proposedAutomation?: string;
  risksOrGuardrails?: string[];
  expectedBenefit?: string;
  error?: string;
}

export interface LongTailSummary {
  singletonWorkflowCount: number;
  /** Counts by dominant classification, so the tail's shape is visible. */
  byClassification: Record<string, number>;
}

export interface WorkflowRecommendationRunMetadata {
  inputFile: string;
  extractionsInputFile?: string;
  createdAt: string;
  sourceWindowDays?: number;
  model: string;
  promptVersion: string;
  scoringFormula: string;
  scoringWeights: Record<string, number>;
  minOccurrencesForRanking: number;
  totalClusters: number;
  rankedClusters: number;
  recommended: number;
  failed: number;
  category: "workflow";
}

export interface WorkflowRecommendationOutput {
  metadata: WorkflowRecommendationRunMetadata;
  recommendations: WorkflowRecommendationItem[];
  longTail: LongTailSummary;
}

export function workflowRecommendationOutputFilePath(
  baseDir: string,
  createdAt: Date,
  windowTag?: string | null,
): string {
  return path.join(baseDir, buildDatedFilename("workflow-recommendations", createdAt, windowTag));
}

export async function writeWorkflowRecommendationOutput(
  output: WorkflowRecommendationOutput,
  filePath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}
