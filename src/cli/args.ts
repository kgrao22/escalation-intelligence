import { parseArgs } from "node:util";

export interface FetchArgs {
  daysBack: number;
  dryRun: boolean;
}

/**
 * Resolves the --days override from CLI args, falling back to the
 * SLACK_DAYS_BACK env default when --days is not supplied.
 */
export function resolveDaysBack(argv: string[], envDefault: number): number {
  return parseFetchArgs(argv, envDefault).daysBack;
}

export function parseFetchArgs(argv: string[], envDefault: number): FetchArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      days: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    strict: false,
  });

  let daysBack = envDefault;
  if (values.days !== undefined) {
    const parsed = Number.parseInt(String(values.days), 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`Invalid --days value: "${values.days}". Must be a positive integer.`);
    }
    daysBack = parsed;
  }

  return { daysBack, dryRun: Boolean(values["dry-run"]) };
}
