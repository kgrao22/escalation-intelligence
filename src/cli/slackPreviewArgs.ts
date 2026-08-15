import { parseArgs } from "node:util";

export interface SlackPreviewArgs {
  report?: string;
  recommendations?: string;
  totalEscalations?: number;
}

export function parseSlackPreviewArgs(argv: string[]): SlackPreviewArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      report: { type: "string" },
      recommendations: { type: "string" },
      "total-escalations": { type: "string" },
    },
    strict: false,
  });

  let totalEscalations: number | undefined;
  if (values["total-escalations"] !== undefined) {
    const parsed = Number.parseInt(String(values["total-escalations"]), 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(
        `Invalid --total-escalations value: "${values["total-escalations"]}". Must be a non-negative integer.`,
      );
    }
    totalEscalations = parsed;
  }

  return {
    report: values.report !== undefined ? String(values.report) : undefined,
    recommendations: values.recommendations !== undefined ? String(values.recommendations) : undefined,
    totalEscalations,
  };
}
