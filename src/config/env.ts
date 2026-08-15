import { z } from "zod";

/**
 * Default model for LLM extraction: Claude Haiku 4.5. Chosen because this
 * milestone's task — structured classification/extraction over many Slack
 * threads — is exactly the "low-cost structured extraction" case, Haiku 4.5
 * fully supports Anthropic's structured-outputs feature (schema-constrained
 * JSON), and it is the cheapest current Claude model. Override via
 * ANTHROPIC_MODEL (e.g. a Sonnet/Opus model) if extraction quality warrants it.
 */
export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5";

/**
 * Default embedding model: voyage-4-large, matching the model the pipeline
 * was validated against in Milestone 4. Emits 1024-dimensional float vectors
 * by default — we never pass `output_dimension`, so the provider default
 * applies and the actual returned dimension is recorded in output metadata.
 *
 * The default matters because embedding reuse is keyed on the model name:
 * if this disagreed with what's in .env.local, dropping the env var would
 * silently produce vectors that are not comparable with existing ones.
 */
export const DEFAULT_VOYAGE_EMBEDDING_MODEL = "voyage-4-large";

/**
 * Cosine-similarity floor for *candidate generation only*.
 *
 * This is NOT a "same issue" threshold. Human calibration on the 90-day
 * dataset found SAME pairs down into the 0.60–0.6499 band and none below it,
 * so 0.60 is where asking the LLM stops being worth the cost — not where
 * recurrence starts. The recurrence decision is made by the adjudicator,
 * never by this number.
 */
export const DEFAULT_RECURRENCE_CANDIDATE_SIMILARITY = 0.6;

export const envSchema = z.object({
  SLACK_BOT_TOKEN: z.string().min(1, "SLACK_BOT_TOKEN is required"),
  SLACK_SOURCE_CHANNEL_ID: z.string().min(1, "SLACK_SOURCE_CHANNEL_ID is required"),
  SLACK_DEST_CHANNEL_ID: z.string().min(1, "SLACK_DEST_CHANNEL_ID is required"),
  SLACK_DAYS_BACK: z.coerce.number().int().positive().default(30),
  // Optional here: only slack:probe / slack:fetch use the schema above, and
  // they never need an Anthropic key. intelligence:extract enforces its own
  // presence via requireAnthropicApiKey() below, at the point it's needed.
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().min(1).default(DEFAULT_ANTHROPIC_MODEL),
  // Optional for the same reason as ANTHROPIC_API_KEY: only
  // intelligence:embed needs it, and it enforces presence at point of use
  // via requireVoyageApiKey(). intelligence:similarity is fully local and
  // needs no key at all.
  VOYAGE_API_KEY: z.string().min(1).optional(),
  VOYAGE_EMBEDDING_MODEL: z.string().min(1).default(DEFAULT_VOYAGE_EMBEDDING_MODEL),
  RECURRENCE_CANDIDATE_SIMILARITY: z.coerce
    .number()
    .min(-1)
    .max(1)
    .default(DEFAULT_RECURRENCE_CANDIDATE_SIMILARITY),
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvValidationError";
  }
}

/**
 * Pure validation function (no filesystem/dotenv access) so it can be unit
 * tested with arbitrary input objects instead of real process.env / files.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new EnvValidationError(`Invalid environment configuration:\n${details}`);
  }

  if (result.data.SLACK_SOURCE_CHANNEL_ID === result.data.SLACK_DEST_CHANNEL_ID) {
    throw new EnvValidationError(
      "SLACK_SOURCE_CHANNEL_ID and SLACK_DEST_CHANNEL_ID must be different. " +
        "The source channel is read-only production data and must never be used as a report destination.",
    );
  }

  return result.data;
}

/**
 * Enforces the presence of ANTHROPIC_API_KEY only at the point a command
 * actually needs it (intelligence:extract) — kept out of the shared schema
 * above so slack:probe and slack:fetch remain usable without an Anthropic key.
 */
export function requireAnthropicApiKey(env: Env): string {
  if (!env.ANTHROPIC_API_KEY) {
    throw new EnvValidationError(
      "ANTHROPIC_API_KEY is required to run LLM extraction. Add it to .env.local.",
    );
  }
  return env.ANTHROPIC_API_KEY;
}

export function requireVoyageApiKey(env: Env): string {
  if (!env.VOYAGE_API_KEY) {
    throw new EnvValidationError(
      "VOYAGE_API_KEY is required to generate embeddings. Add it to .env.local.",
    );
  }
  return env.VOYAGE_API_KEY;
}
