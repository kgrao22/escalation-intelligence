import { parseArgs } from "node:util";

/** How many top pairs the similarity report prints by default. */
export const DEFAULT_TOP_PAIRS = 30;

export interface WorkflowSimilarityArgs {
  input?: string;
  top: number;
}

export function parseWorkflowSimilarityArgs(argv: string[]): WorkflowSimilarityArgs {
  const { values } = parseArgs({
    args: argv,
    options: { input: { type: "string" }, top: { type: "string" } },
    strict: false,
  });

  let top = DEFAULT_TOP_PAIRS;
  if (values.top !== undefined) {
    const parsed = Number.parseInt(String(values.top), 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`Invalid --top value: "${values.top}". Must be a positive integer.`);
    }
    top = parsed;
  }

  return { input: values.input !== undefined ? String(values.input) : undefined, top };
}
