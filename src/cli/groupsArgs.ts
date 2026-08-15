import { parseArgs } from "node:util";
import { parseCategory, type PipelineCategory } from "../categories.js";

export interface GroupsArgs {
  input?: string;
  extractions?: string;
  dryRun: boolean;
  category: PipelineCategory;
}

export function parseGroupsArgs(argv: string[]): GroupsArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: "string" },
      extractions: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      category: { type: "string" },
    },
    strict: false,
  });

  return {
    input: values.input !== undefined ? String(values.input) : undefined,
    extractions: values.extractions !== undefined ? String(values.extractions) : undefined,
    dryRun: Boolean(values["dry-run"]),
    category: parseCategory(values.category === undefined ? undefined : String(values.category)),
  };
}
