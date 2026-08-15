import { parseArgs } from "node:util";

export interface WorkflowRecommendArgs {
  input?: string;
  extractions?: string;
  dryRun: boolean;
  limit?: number;
}

export function parseWorkflowRecommendArgs(argv: string[]): WorkflowRecommendArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: "string" },
      extractions: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      limit: { type: "string" },
    },
    strict: false,
  });

  let limit: number | undefined;
  if (values.limit !== undefined) {
    const parsed = Number.parseInt(String(values.limit), 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`Invalid --limit value: "${values.limit}". Must be a positive integer.`);
    }
    limit = parsed;
  }

  return {
    input: values.input !== undefined ? String(values.input) : undefined,
    extractions: values.extractions !== undefined ? String(values.extractions) : undefined,
    dryRun: Boolean(values["dry-run"]),
    limit,
  };
}
