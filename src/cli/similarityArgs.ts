import { parseArgs } from "node:util";

export interface SimilarityArgs {
  input?: string;
}

export function parseSimilarityArgs(argv: string[]): SimilarityArgs {
  const { values } = parseArgs({
    args: argv,
    options: { input: { type: "string" } },
    strict: false,
  });

  return { input: values.input !== undefined ? String(values.input) : undefined };
}
