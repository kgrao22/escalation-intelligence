import { describe, expect, it } from "vitest";
import { assertSafePostTarget, UnsafePostTargetError } from "../src/slack/safety.js";

describe("assertSafePostTarget", () => {
  it("does not throw when destination and source channels differ", () => {
    expect(() =>
      assertSafePostTarget({
        destinationChannelId: "C0DEST00000",
        sourceChannelId: "C0SOURCE0000",
      }),
    ).not.toThrow();
  });

  it("throws UnsafePostTargetError when destination equals the read-only source channel", () => {
    expect(() =>
      assertSafePostTarget({
        destinationChannelId: "C0SOURCE0000",
        sourceChannelId: "C0SOURCE0000",
      }),
    ).toThrow(UnsafePostTargetError);
  });

  it("includes both channel IDs in the error message for debuggability", () => {
    try {
      assertSafePostTarget({
        destinationChannelId: "C0SOURCE0000",
        sourceChannelId: "C0SOURCE0000",
      });
      throw new Error("expected assertSafePostTarget to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafePostTargetError);
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("C0SOURCE0000");
    }
  });
});
