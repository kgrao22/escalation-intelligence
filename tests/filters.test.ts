import { describe, expect, it } from "vitest";
import { isSystemNoiseMessage } from "../src/slack/filters.js";

describe("isSystemNoiseMessage", () => {
  it("flags known Slack housekeeping subtypes as noise", () => {
    expect(isSystemNoiseMessage({ subtype: "channel_join" })).toBe(true);
    expect(isSystemNoiseMessage({ subtype: "channel_leave" })).toBe(true);
    expect(isSystemNoiseMessage({ subtype: "channel_topic" })).toBe(true);
    expect(isSystemNoiseMessage({ subtype: "channel_purpose" })).toBe(true);
    expect(isSystemNoiseMessage({ subtype: "channel_name" })).toBe(true);
    expect(isSystemNoiseMessage({ subtype: "pinned_item" })).toBe(true);
  });

  it("does not flag ordinary human messages with no subtype", () => {
    expect(isSystemNoiseMessage({})).toBe(false);
    expect(isSystemNoiseMessage({ subtype: undefined })).toBe(false);
  });

  it("keeps messages with unrecognized subtypes (e.g. thread broadcasts)", () => {
    expect(isSystemNoiseMessage({ subtype: "thread_broadcast" })).toBe(false);
    expect(isSystemNoiseMessage({ subtype: "bot_message" })).toBe(false);
  });

  it("keeps normal messages even if they are not technical escalations", () => {
    expect(isSystemNoiseMessage({ subtype: undefined })).toBe(false);
  });
});
