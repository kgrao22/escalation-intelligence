import { parseArgs } from "node:util";

export interface SlackCleanupArgs {
  window: string;
  dryRun: boolean;
  /** The ONLY flag that permits live deletion. Absent means preview. */
  deleteConfirmed: boolean;
}

export function parseSlackCleanupArgs(argv: string[]): SlackCleanupArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      window: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      delete: { type: "boolean", default: false },
    },
    strict: false,
  });

  const window = values.window === undefined ? "90d" : String(values.window);
  if (!/^\d+d$/.test(window)) {
    throw new Error(`Invalid --window value: "${window}". Expected a form like 90d.`);
  }

  return { window, dryRun: Boolean(values["dry-run"]), deleteConfirmed: Boolean(values.delete) };
}
