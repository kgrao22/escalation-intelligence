/**
 * The pipeline runs two independent intelligence tracks over the same
 * extraction output.
 *
 * They are kept separate all the way through: separate embedding pools (so a
 * defect statement is never compared against a manual-task statement),
 * separate adjudication prompts and relationship vocabularies, separate
 * recurrence graphs, and separate report sections. Recurrence frequency for
 * one must never be inflated by the other.
 */
export type PipelineCategory = "technical" | "workflow";

export const PIPELINE_CATEGORIES: readonly PipelineCategory[] = ["technical", "workflow"];

export interface CategoryFilePrefixes {
  embeddings: string;
  adjudications: string;
  groups: string;
}

/**
 * The technical track keeps its original, untagged prefixes so every existing
 * artifact and command continues to resolve unchanged.
 */
const PREFIXES: Record<PipelineCategory, CategoryFilePrefixes> = {
  technical: {
    embeddings: "embeddings",
    adjudications: "adjudications",
    groups: "groups",
  },
  workflow: {
    embeddings: "workflow-embeddings",
    adjudications: "workflow-adjudications",
    groups: "workflow-groups",
  },
};

export function filePrefixesFor(category: PipelineCategory): CategoryFilePrefixes {
  return PREFIXES[category];
}

export function isPipelineCategory(value: string): value is PipelineCategory {
  return (PIPELINE_CATEGORIES as readonly string[]).includes(value);
}

export function parseCategory(value: string | undefined, fallback: PipelineCategory = "technical"): PipelineCategory {
  if (value === undefined) {
    return fallback;
  }
  if (!isPipelineCategory(value)) {
    throw new Error(`Invalid --category value: "${value}". Must be one of: ${PIPELINE_CATEGORIES.join(", ")}.`);
  }
  return value;
}

export function categoryLabel(category: PipelineCategory): string {
  return category === "technical" ? "technical issue" : "manual workflow";
}
