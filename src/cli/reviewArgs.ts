import { parseArgs } from "node:util";

export interface ReviewArgs {
  input?: string;
  maxPerBucket?: number;
}

export function parseReviewArgs(argv: string[]): ReviewArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: "string" },
      "per-bucket": { type: "string" },
    },
    strict: false,
  });

  let maxPerBucket: number | undefined;
  if (values["per-bucket"] !== undefined) {
    const parsed = Number.parseInt(String(values["per-bucket"]), 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`Invalid --per-bucket value: "${values["per-bucket"]}". Must be a positive integer.`);
    }
    maxPerBucket = parsed;
  }

  return {
    input: values.input !== undefined ? String(values.input) : undefined,
    maxPerBucket,
  };
}
