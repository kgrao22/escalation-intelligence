import { parseArgs } from "node:util";
import { WORKFLOW_CANDIDATE_SIMILARITY_FLOOR } from "../workflow/workflowCandidatePairs.js";

export interface WorkflowAdjudicateArgs {
  embeddings?: string;
  dryRun: boolean;
  limit?: number;
  floor: number;
  /** Inclusive lower bound of the calibration band. */
  minSimilarity?: number;
  /** Exclusive upper bound of the calibration band. */
  maxSimilarity?: number;
  /** Print the selected band locally and make zero API calls. */
  inspect: boolean;
}

function parseUnitInterval(name: string, raw: unknown): number {
  const parsed = Number.parseFloat(String(raw));
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Invalid --${name} value: "${String(raw)}". Must be between 0 and 1.`);
  }
  return parsed;
}

export function parseWorkflowAdjudicateArgs(argv: string[]): WorkflowAdjudicateArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      embeddings: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      limit: { type: "string" },
      floor: { type: "string" },
      "min-similarity": { type: "string" },
      "max-similarity": { type: "string" },
      inspect: { type: "boolean", default: false },
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

  const floorGiven = values.floor !== undefined;
  const floor = floorGiven ? parseUnitInterval("floor", values.floor) : WORKFLOW_CANDIDATE_SIMILARITY_FLOOR;

  const minSimilarity =
    values["min-similarity"] !== undefined
      ? parseUnitInterval("min-similarity", values["min-similarity"])
      : undefined;
  const maxSimilarity =
    values["max-similarity"] !== undefined
      ? parseUnitInterval("max-similarity", values["max-similarity"])
      : undefined;

  // The floor is the safety rail. Sampling below it must be a deliberate,
  // explicit act, not a side effect of naming a band.
  if (minSimilarity !== undefined && minSimilarity < floor && !floorGiven) {
    throw new Error(
      `--min-similarity=${minSimilarity} is below the candidate floor of ${floor}. ` +
        `Pass --floor=${minSimilarity} as well if you really mean to sample below the floor.`,
    );
  }
  if (minSimilarity !== undefined && maxSimilarity !== undefined && minSimilarity >= maxSimilarity) {
    throw new Error(
      `--min-similarity (${minSimilarity}) must be less than --max-similarity (${maxSimilarity}).`,
    );
  }

  return {
    embeddings: values.embeddings !== undefined ? String(values.embeddings) : undefined,
    dryRun: Boolean(values["dry-run"]),
    limit,
    floor,
    minSimilarity,
    maxSimilarity,
    inspect: Boolean(values.inspect),
  };
}
