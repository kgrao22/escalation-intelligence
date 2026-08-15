import fs from "node:fs/promises";
import path from "node:path";
import { listDatedFiles, parseDatedFilename, type DatedFileParts } from "./datedFiles.js";

export class InputResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputResolutionError";
  }
}

export interface ResolvedInput {
  absolutePath: string;
  relativePath: string;
  filename: string;
  /** e.g. "90d"; null for pre-tagging files or paths that don't follow the convention. */
  windowTag: string | null;
  /** True when the file was auto-selected rather than passed via --input. */
  autoSelected: boolean;
  /** Other candidates that were NOT chosen — surfaced so a wrong pick is never silent. */
  alternatives: DatedFileParts[];
}

/**
 * Chooses the newest candidate but reports what else was available. With
 * multiple lookback windows on disk (30d and 90d), "newest" is not
 * self-evidently the one you meant, so callers are expected to print the
 * alternatives and point at --input.
 */
export function selectLatestCandidate(filenames: string[], prefix: string): {
  chosen: DatedFileParts | null;
  alternatives: DatedFileParts[];
} {
  const candidates = listDatedFiles(filenames, prefix);
  const chosen = candidates.at(-1) ?? null;
  return {
    chosen,
    alternatives: chosen ? candidates.filter((candidate) => candidate.filename !== chosen.filename) : [],
  };
}

async function assertReadableFile(absolutePath: string, relativePath: string): Promise<void> {
  let stats;
  try {
    stats = await fs.stat(absolutePath);
  } catch {
    throw new InputResolutionError(`Input file not found: ${relativePath}`);
  }
  if (!stats.isFile()) {
    throw new InputResolutionError(`Input path is not a file: ${relativePath}`);
  }
}

export interface ResolveInputParams {
  /** Value of --input, if supplied. */
  explicitInput: string | undefined;
  /** Directory searched when --input is omitted. */
  defaultDir: string;
  /** Filename prefix, e.g. "escalations" | "extractions" | "embeddings". */
  prefix: string;
  /** Command to suggest when nothing is found. */
  missingHint: string;
}

/**
 * Resolves which dataset a command should read. An explicit --input always
 * wins and is validated to exist; otherwise the newest matching file in the
 * default directory is used.
 */
export async function resolveInputFile(params: ResolveInputParams): Promise<ResolvedInput> {
  if (params.explicitInput) {
    const absolutePath = path.resolve(process.cwd(), params.explicitInput);
    const relativePath = path.relative(process.cwd(), absolutePath);
    await assertReadableFile(absolutePath, relativePath);

    const filename = path.basename(absolutePath);
    return {
      absolutePath,
      relativePath,
      filename,
      windowTag: parseDatedFilename(filename, params.prefix)?.windowTag ?? null,
      autoSelected: false,
      alternatives: [],
    };
  }

  let filenames: string[];
  try {
    filenames = await fs.readdir(params.defaultDir);
  } catch {
    filenames = [];
  }

  const { chosen, alternatives } = selectLatestCandidate(filenames, params.prefix);
  if (!chosen) {
    throw new InputResolutionError(
      `No ${params.prefix}-*.json file found in ${path.relative(process.cwd(), params.defaultDir)}/.\n` +
        `  ${params.missingHint}`,
    );
  }

  const absolutePath = path.join(params.defaultDir, chosen.filename);
  return {
    absolutePath,
    relativePath: path.relative(process.cwd(), absolutePath),
    filename: chosen.filename,
    windowTag: chosen.windowTag,
    autoSelected: true,
    alternatives,
  };
}

/** Lines warning that other datasets exist, so an auto-pick is never silent. */
export function describeInputSelection(resolved: ResolvedInput): string[] {
  const lines = [`✓ ${resolved.relativePath}${resolved.windowTag ? ` (window: ${resolved.windowTag})` : ""}`];

  if (resolved.autoSelected && resolved.alternatives.length > 0) {
    lines.push("");
    lines.push(`⚠ Auto-selected the newest of ${resolved.alternatives.length + 1} candidates. Others available:`);
    for (const alternative of resolved.alternatives) {
      lines.push(`    ${alternative.filename}${alternative.windowTag ? ` (window: ${alternative.windowTag})` : ""}`);
    }
    lines.push("  Pass --input=<path> to choose explicitly.");
  }

  return lines;
}
