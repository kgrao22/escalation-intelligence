import fs from "node:fs/promises";
import path from "node:path";
import type { WorkflowCluster } from "../workflow/buildWorkflowClusters.js";
import { buildDatedFilename } from "./datedFiles.js";

export interface WorkflowClusterRunMetadata {
  extractionsInputFile: string;
  adjudicationsInputFile: string;
  generatedAt: string;
  sourceWindowDays?: number;
  /** Named explicitly so a future change of method is visible in the artifact. */
  clusteringAlgorithm:
    | "connected_components_over_same_underlying_workflow_edges"
    | "greedy_disjoint_maximal_clique_cover_complete_link";
  clusterIdScheme: string;
  totalWorkflowCandidates: number;
  totalClusters: number;
  recurringClusters: number;
  singletonClusters: number;
  largestClusterSize: number;
  sameEdges: number;
  relatedEdges: number;
  differentEdges: number;
  danglingSameEdges: number;
  adjudicationModel: string;
  adjudicationPromptVersion: string;
  category: "workflow";
}

export interface WorkflowClusterOutput {
  metadata: WorkflowClusterRunMetadata;
  clusters: WorkflowCluster[];
}

export function workflowClusterOutputFilePath(
  baseDir: string,
  generatedAt: Date,
  windowTag?: string | null,
): string {
  return path.join(baseDir, buildDatedFilename("workflow-clusters", generatedAt, windowTag));
}

export async function writeWorkflowClusterOutput(
  output: WorkflowClusterOutput,
  filePath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}
