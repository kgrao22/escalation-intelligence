import { parseArgs } from "node:util";

export interface ExtractArgs {
  input?: string;
  limit?: number;
  dryRun: boolean;
  /** Re-analyse ONLY the threads whose prior extraction failed. */
  retryFailed: boolean;
}

export function parseExtractArgs(argv: string[]): ExtractArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: "string" },
      limit: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "retry-failed": { type: "boolean", default: false },
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
    dryRun: Boolean(values["dry-run"]),
    retryFailed: Boolean(values["retry-failed"]),
  };
}
