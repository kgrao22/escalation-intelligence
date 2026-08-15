import { describe, expect, it } from "vitest";
import {
  assertPublicationSafety,
  assertWriteTarget,
  EXPECTED_DESTINATION_CHANNEL_ID,
  FORBIDDEN_SOURCE_CHANNEL_ID,
  PublicationSafetyError,
} from "../../src/slackPublishing/safety.js";

const DEST = "C0DEST00000";
const SOURCE = "C0SOURCE0000";

const valid = {
  destinationChannelId: DEST,
  sourceChannelId: SOURCE,
  previewDestinationChannelId: DEST,
  previewPosted: false,
};

describe("hard-locked channel constants", () => {
  it("locks the destination to the intelligence channel", () => {
    expect(EXPECTED_DESTINATION_CHANNEL_ID).toBe("C0DEST00000");
  });

  it("names the escalations channel as the forbidden source", () => {
    expect(FORBIDDEN_SOURCE_CHANNEL_ID).toBe("C0SOURCE0000");
  });
});

describe("assertPublicationSafety", () => {
  it("passes when every precondition holds", () => {
    expect(() => assertPublicationSafety(valid)).not.toThrow();
  });

  it("aborts when destination equals source", () => {
    expect(() =>
      assertPublicationSafety({ ...valid, destinationChannelId: SOURCE, previewDestinationChannelId: SOURCE }),
    ).toThrow(PublicationSafetyError);
  });

  it("aborts when the destination is any channel other than C0DEST00000", () => {
    expect(() =>
      assertPublicationSafety({
        ...valid,
        destinationChannelId: "C09999999",
        previewDestinationChannelId: "C09999999",
      }),
    ).toThrow(/may only publish to C0DEST00000/);
  });

  it("aborts when the configured source is not the expected escalations channel", () => {
    expect(() => assertPublicationSafety({ ...valid, sourceChannelId: "C0OTHER" })).toThrow(
      /expected C0SOURCE0000/,
    );
  });

  it("aborts when the preview targets a different channel than config", () => {
    expect(() => assertPublicationSafety({ ...valid, previewDestinationChannelId: "C09999999" })).toThrow(
      /built for a different channel/,
    );
  });

  it("aborts when the preview is already marked as posted", () => {
    expect(() =>
      assertPublicationSafety({ ...valid, previewPosted: true as unknown as false }),
    ).toThrow(/already marked as posted/);
  });
});

describe("assertWriteTarget — per-write guard", () => {
  it("allows the single permitted destination", () => {
    expect(() => assertWriteTarget(DEST)).not.toThrow();
  });

  it("refuses to write to the read-only source channel", () => {
    expect(() => assertWriteTarget(SOURCE)).toThrow(PublicationSafetyError);
    expect(() => assertWriteTarget(SOURCE)).toThrow(/read-only source channel/);
  });

  it("refuses any other channel", () => {
    expect(() => assertWriteTarget("C0ANYTHINGELSE")).toThrow(/only permitted destination/);
    expect(() => assertWriteTarget("")).toThrow(PublicationSafetyError);
  });
});
