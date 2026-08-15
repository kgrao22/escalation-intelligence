import { parseArgs } from "node:util";
import { parseCategory, type PipelineCategory } from "../categories.js";

export interface AdjudicateArgs {
  embeddings?: string;
  extractions?: string;
  limit?: number;
  floor?: number;
  dryRun: boolean;
  category: PipelineCategory;
}

export function parseAdjudicateArgs(argv: string[]): AdjudicateArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      embeddings: { type: "string" },
      extractions: { type: "string" },
      limit: { type: "string" },
      floor: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      category: { type: "string" },
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

  let floor: number | undefined;
  if (values.floor !== undefined) {
    const parsed = Number.parseFloat(String(values.floor));
    if (!Number.isFinite(parsed) || parsed < -1 || parsed > 1) {
      throw new Error(`Invalid --floor value: "${values.floor}". Must be a number between -1 and 1.`);
    }
    floor = parsed;
  }

  return {
    embeddings: values.embeddings !== undefined ? String(values.embeddings) : undefined,
    extractions: values.extractions !== undefined ? String(values.extractions) : undefined,
    limit,
    floor,
    dryRun: Boolean(values["dry-run"]),
    category: parseCategory(values.category === undefined ? undefined : String(values.category)),
  };
}
