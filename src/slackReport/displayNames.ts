import fs from "node:fs";
import path from "node:path";

/**
 * Short display names for Slack.
 *
 * The persisted group names come from adjudication and are written for
 * precision, not for a Slack headline — several run to 15+ words. These are
 * hand-written short forms keyed by the exact persisted name.
 *
 * The mapping is DEPLOYMENT-SPECIFIC and is deliberately not stored in this
 * repository: the keys are the real recurring-issue names produced against
 * whatever data the pipeline was pointed at, and committing them would publish
 * an organisation's defect list to anyone who reads the source. Supply your own
 * in a git-ignored `display-names.local.json` at the repository root — see
 * `display-names.example.json` for the shape.
 *
 * Persisted names are never modified; this is a presentation-only lookup.
 *
 * The fallback is deliberately "use the name unchanged" rather than truncating.
 * Cutting a sentence at N characters produces confident-looking nonsense
 * ("Overly strict document validation blocks email delivery for valid…"),
 * which is worse in a report people act on than a name that is merely long.
 */

/** Repository-root file consulted when no explicit path is given. */
export const DISPLAY_NAMES_FILENAME = "display-names.local.json";

function defaultDisplayNamesPath(): string {
  return path.resolve(process.cwd(), DISPLAY_NAMES_FILENAME);
}

/**
 * Reads a persisted-name → short-name mapping from disk.
 *
 * Every failure mode — file absent, unreadable, malformed JSON, wrong shape —
 * degrades to an empty map rather than throwing. Shortening a headline is a
 * presentation nicety, and it must never be able to fail a publication run that
 * is otherwise correct. Non-string values are skipped individually so one bad
 * entry cannot discard an otherwise valid file.
 */
export function loadShortDisplayNames(filePath: string = defaultDisplayNamesPath()): ReadonlyMap<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return new Map();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Map();
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return new Map();
  }

  const entries = new Map<string, string>();
  for (const [persisted, display] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof display === "string" && persisted.trim() !== "" && display.trim() !== "") {
      entries.set(persisted, display);
    }
  }
  return entries;
}

let cached: ReadonlyMap<string, string> | null = null;

function displayNameMap(): ReadonlyMap<string, string> {
  cached ??= loadShortDisplayNames();
  return cached;
}

export function displayNameFor(persistedName: string | null): string {
  if (persistedName === null || persistedName.trim() === "") {
    return "(unnamed recurring issue)";
  }
  return displayNameMap().get(persistedName) ?? persistedName;
}

/** True when a short form exists; useful for spotting new groups that need one. */
export function hasShortDisplayName(persistedName: string | null): boolean {
  return persistedName !== null && displayNameMap().has(persistedName);
}
