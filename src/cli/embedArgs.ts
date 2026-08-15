import { parseArgs } from "node:util";
import { parseCategory, type PipelineCategory } from "../categories.js";

export interface EmbedArgs {
  input?: string;
  dryRun: boolean;
  category: PipelineCategory;
}

export function parseEmbedArgs(argv: string[]): EmbedArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      category: { type: "string" },
    },
    strict: false,
  });

  return {
    input: values.input !== undefined ? String(values.input) : undefined,
    dryRun: Boolean(values["dry-run"]),
    category: parseCategory(values.category === undefined ? undefined : String(values.category)),
  };
}
