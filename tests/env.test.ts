import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_RECURRENCE_CANDIDATE_SIMILARITY,
  DEFAULT_VOYAGE_EMBEDDING_MODEL,
  EnvValidationError,
  parseEnv,
  requireAnthropicApiKey,
  requireVoyageApiKey,
} from "../src/config/env.js";

const validSource = {
  SLACK_BOT_TOKEN: "xoxb-test-token",
  SLACK_SOURCE_CHANNEL_ID: "C0SOURCE0000",
  SLACK_DEST_CHANNEL_ID: "C0DEST00000",
};

describe("parseEnv", () => {
  it("parses valid environment variables and applies all defaults", () => {
    const env = parseEnv(validSource);
    expect(env).toEqual({
      ...validSource,
      SLACK_DAYS_BACK: 30,
      ANTHROPIC_MODEL: DEFAULT_ANTHROPIC_MODEL,
      VOYAGE_EMBEDDING_MODEL: DEFAULT_VOYAGE_EMBEDDING_MODEL,
      RECURRENCE_CANDIDATE_SIMILARITY: DEFAULT_RECURRENCE_CANDIDATE_SIMILARITY,
    });
  });

  it("defaults the embedding model to voyage-4-large, matching the validated pipeline", () => {
    expect(DEFAULT_VOYAGE_EMBEDDING_MODEL).toBe("voyage-4-large");
    expect(parseEnv(validSource).VOYAGE_EMBEDDING_MODEL).toBe("voyage-4-large");
  });

  it("respects an explicit VOYAGE_EMBEDDING_MODEL override", () => {
    expect(parseEnv({ ...validSource, VOYAGE_EMBEDDING_MODEL: "voyage-4" }).VOYAGE_EMBEDDING_MODEL).toBe("voyage-4");
  });

  it("does not require ANTHROPIC_API_KEY for Slack-only commands", () => {
    expect(() => parseEnv(validSource)).not.toThrow();
  });

  it("respects an explicit ANTHROPIC_MODEL override", () => {
    const env = parseEnv({ ...validSource, ANTHROPIC_MODEL: "claude-sonnet-5" });
    expect(env.ANTHROPIC_MODEL).toBe("claude-sonnet-5");
  });

  it("respects an explicit SLACK_DAYS_BACK value", () => {
    const env = parseEnv({ ...validSource, SLACK_DAYS_BACK: "90" });
    expect(env.SLACK_DAYS_BACK).toBe(90);
  });

  it("throws EnvValidationError when SLACK_BOT_TOKEN is missing", () => {
    const { SLACK_BOT_TOKEN, ...rest } = validSource;
    expect(() => parseEnv(rest)).toThrow(EnvValidationError);
  });

  it("throws EnvValidationError when SLACK_SOURCE_CHANNEL_ID is missing", () => {
    const { SLACK_SOURCE_CHANNEL_ID, ...rest } = validSource;
    expect(() => parseEnv(rest)).toThrow(EnvValidationError);
  });

  it("throws EnvValidationError when SLACK_DEST_CHANNEL_ID is missing", () => {
    const { SLACK_DEST_CHANNEL_ID, ...rest } = validSource;
    expect(() => parseEnv(rest)).toThrow(EnvValidationError);
  });

  it("throws EnvValidationError when SLACK_DAYS_BACK is not a positive integer", () => {
    expect(() => parseEnv({ ...validSource, SLACK_DAYS_BACK: "-5" })).toThrow(EnvValidationError);
    expect(() => parseEnv({ ...validSource, SLACK_DAYS_BACK: "not-a-number" })).toThrow(EnvValidationError);
  });

  it("throws EnvValidationError when source and destination channel IDs are identical", () => {
    expect(() =>
      parseEnv({
        ...validSource,
        SLACK_DEST_CHANNEL_ID: validSource.SLACK_SOURCE_CHANNEL_ID,
      }),
    ).toThrow(/must be different/i);
  });

  it("never includes the bot token value in a validation error message", () => {
    try {
      parseEnv({ ...validSource, SLACK_DEST_CHANNEL_ID: validSource.SLACK_SOURCE_CHANNEL_ID });
      throw new Error("expected parseEnv to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(validSource.SLACK_BOT_TOKEN);
    }
  });
});

describe("requireAnthropicApiKey", () => {
  it("returns the key when present", () => {
    const env = parseEnv({ ...validSource, ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(requireAnthropicApiKey(env)).toBe("sk-ant-test");
  });

  it("throws EnvValidationError when ANTHROPIC_API_KEY is absent", () => {
    const env = parseEnv(validSource);
    expect(() => requireAnthropicApiKey(env)).toThrow(EnvValidationError);
  });
});

describe("requireVoyageApiKey", () => {
  it("returns the key when present", () => {
    const env = parseEnv({ ...validSource, VOYAGE_API_KEY: "pa-test" });
    expect(requireVoyageApiKey(env)).toBe("pa-test");
  });

  it("throws EnvValidationError when VOYAGE_API_KEY is absent", () => {
    expect(() => requireVoyageApiKey(parseEnv(validSource))).toThrow(EnvValidationError);
  });

  it("does not require VOYAGE_API_KEY for non-embedding commands", () => {
    expect(() => parseEnv(validSource)).not.toThrow();
  });
});
