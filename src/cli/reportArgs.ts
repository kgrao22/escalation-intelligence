import { parseArgs } from "node:util";

export interface ReportArgs {
  input?: string;
  /** Explicit path to a workflow-groups file; auto-resolved when omitted. */
  workflowGroups?: string;
  dryRun: boolean;
}

export function parseReportArgs(argv: string[]): ReportArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: "string" },
      "workflow-groups": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    strict: false,
  });

  return {
    input: values.input !== undefined ? String(values.input) : undefined,
    workflowGroups:
      values["workflow-groups"] !== undefined ? String(values["workflow-groups"]) : undefined,
    dryRun: Boolean(values["dry-run"]),
  };
}
