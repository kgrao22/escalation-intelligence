import { parseArgs } from "node:util";

export interface ReviewBuilderArgs {
  window: string;
  workflowRecommendations?: string;
  workflowClusters?: string;
  extractions?: string;
  technicalReport?: string;
  technicalRecommendations?: string;
  dryRun: boolean;
}

export function parseReviewBuilderArgs(argv: string[]): ReviewBuilderArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      window: { type: "string" },
      "workflow-recommendations": { type: "string" },
      "workflow-clusters": { type: "string" },
      extractions: { type: "string" },
      "technical-report": { type: "string" },
      "technical-recommendations": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    strict: false,
  });

  const window = values.window === undefined ? "180d" : String(values.window);
  if (!/^\d+d$/.test(window)) {
    throw new Error(`Invalid --window value: "${window}". Expected a form like 180d.`);
  }

  const str = (value: unknown): string | undefined => (value === undefined ? undefined : String(value));

  return {
    window,
    workflowRecommendations: str(values["workflow-recommendations"]),
    workflowClusters: str(values["workflow-clusters"]),
    extractions: str(values.extractions),
    technicalReport: str(values["technical-report"]),
    technicalRecommendations: str(values["technical-recommendations"]),
    dryRun: Boolean(values["dry-run"]),
  };
}
