/**
 * Pipeline artifacts are named `<prefix>[-<window>]-YYYY-MM-DD.json`, e.g.
 * `escalations-90d-2026-08-09.json`. The optional window tag records which
 * lookback window the data came from, so a 30-day and a 90-day run on the
 * same day produce different files instead of silently overwriting each
 * other.
 *
 * The tag is deliberately restricted to `\d+d`, which cannot be confused
 * with the date segment, and files written before window tagging existed
 * (`escalations-2026-08-09.json`) still parse — with a null tag — so older
 * datasets remain readable.
 */
export interface DatedFileParts {
  filename: string;
  prefix: string;
  /** e.g. "90d"; null for files written before window tagging. */
  windowTag: string | null;
  /** 1 for an unversioned filename, N for `-vN-`. Higher supersedes lower. */
  generation: number;
  /** YYYY-MM-DD */
  date: string;
}

export function windowTagForDays(daysBack: number): string {
  return `${daysBack}d`;
}

export function formatDateStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function buildDatedFilename(prefix: string, date: Date, windowTag?: string | null): string {
  const tagSegment = windowTag ? `-${windowTag}` : "";
  return `${prefix}${tagSegment}-${formatDateStamp(date)}.json`;
}

/**
 * Matches `<prefix>[-<window>][-v<generation>]-<date>.json`.
 *
 * The generation segment exists because a stage can be re-run with an improved
 * algorithm over the same inputs (e.g. `report-365d-v2-2026-08-14.json`).
 * Without it in the pattern, a versioned artifact simply did not parse and
 * prefix resolution silently fell back to the superseded unversioned file.
 */
function datedFilePattern(prefix: string): RegExp {
  return new RegExp(`^${prefix}(?:-(\\d+d))?(?:-v(\\d+))?-(\\d{4}-\\d{2}-\\d{2})\\.json$`);
}

export function parseDatedFilename(filename: string, prefix: string): DatedFileParts | null {
  const match = datedFilePattern(prefix).exec(filename);
  if (!match) {
    return null;
  }
  return {
    filename,
    prefix,
    windowTag: match[1] ?? null,
    // An unversioned filename is generation 1; `-v2-` is generation 2.
    generation: match[2] ? Number.parseInt(match[2], 10) : 1,
    date: match[3] as string,
  };
}

/**
 * Every matching artifact, oldest first. Ties on date are broken by filename
 * so ordering is deterministic rather than dependent on directory order.
 */
export function listDatedFiles(filenames: string[], prefix: string): DatedFileParts[] {
  return filenames
    .map((filename) => parseDatedFilename(filename, prefix))
    .filter((parts): parts is DatedFileParts => parts !== null)
    // Date first, then generation, so a newer algorithm's output always wins
    // over the superseded run it replaces on the same day. Filename is the
    // final deterministic tie-break.
    .sort((left, right) => {
      if (left.date !== right.date) {
        return left.date.localeCompare(right.date);
      }
      if (left.generation !== right.generation) {
        return left.generation - right.generation;
      }
      return left.filename.localeCompare(right.filename);
    });
}

/** The newest matching artifact, or null when none exist. */
export function pickLatestDatedFilename(filenames: string[], prefix: string): string | null {
  return listDatedFiles(filenames, prefix).at(-1)?.filename ?? null;
}
