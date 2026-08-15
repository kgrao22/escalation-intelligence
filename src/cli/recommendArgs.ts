import { parseArgs } from "node:util";

export interface RecommendArgs {
  input?: string;
  limit?: number;
  model?: string;
  dryRun: boolean;
}

export function parseRecommendArgs(argv: string[]): RecommendArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: "string" },
      limit: { type: "string" },
      model: { type: "string" },
      "dry-run": { type: "boolean", default: false },
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
    limit,
    model: values.model !== undefined ? String(values.model) : undefined,
    dryRun: Boolean(values["dry-run"]),
  };
}
