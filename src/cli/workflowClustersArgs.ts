import { parseArgs } from "node:util";

export interface WorkflowClustersArgs {
  extractions?: string;
  adjudications?: string;
  dryRun: boolean;
  top: number;
}

export function parseWorkflowClustersArgs(argv: string[]): WorkflowClustersArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      extractions: { type: "string" },
      adjudications: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      top: { type: "string" },
    },
    strict: false,
  });

  let top = 10;
  if (values.top !== undefined) {
    const parsed = Number.parseInt(String(values.top), 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`Invalid --top value: "${values.top}". Must be a positive integer.`);
    }
    top = parsed;
  }

  return {
    extractions: values.extractions !== undefined ? String(values.extractions) : undefined,
    adjudications: values.adjudications !== undefined ? String(values.adjudications) : undefined,
    dryRun: Boolean(values["dry-run"]),
    top,
  };
}
