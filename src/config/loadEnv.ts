import { config as loadDotenvFile } from "dotenv";
import path from "node:path";
import { parseEnv, type Env } from "./env.js";

let cachedEnv: Env | undefined;

/**
 * Loads .env.local (if present) and validates process.env against the
 * schema in env.ts. Cached per process so repeated calls are cheap and
 * .env.local is only read once. Never logs or returns the raw process.env —
 * callers only ever see the typed, validated Env object.
 */
export function getEnv(): Env {
  if (cachedEnv) {
    return cachedEnv;
  }

  loadDotenvFile({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });
  cachedEnv = parseEnv(process.env);
  return cachedEnv;
}
