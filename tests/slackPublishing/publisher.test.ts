import { describe, expect, it, vi } from "vitest";
import {
  createPublisher,
  SlackPublishError,
  type SlackPostFn,
  type SlackPostRequest,
} from "../../src/slackPublishing/client.js";
import { PublicationSafetyError } from "../../src/slackPublishing/safety.js";
import {
  DEFAULT_SLACK_RETRY_OPTIONS,
  isRetryableSlackError,
  retryAfterMs,
  withSlackRetry,
} from "../../src/slackPublishing/retry.js";

const DEST = "C0DEST00000";
const SOURCE = "C0SOURCE0000";
const noSleep = () => Promise.resolve();

function okPostFn(ts = "1700000000.000100"): SlackPostFn {
  return vi.fn(async () => ({ ok: true, ts }));
}

describe("createPublisher — channel guard", () => {
  it("posts the overview to the permitted destination without a thread_ts", async () => {
    const postFn = okPostFn();
    const publisher = createPublisher(postFn, DEST);

    const ts = await publisher.postOverview("overview text");

    expect(ts).toBe("1700000000.000100");
    const request = vi.mocked(postFn).mock.calls[0]?.[0] as SlackPostRequest;
    expect(request.channel).toBe(DEST);
    expect(request.text).toBe("overview text");
    expect(request.thread_ts).toBeUndefined();
  });

  it("refuses to construct writes against the source channel", async () => {
    const postFn = okPostFn();
    const publisher = createPublisher(postFn, SOURCE);

    await expect(publisher.postOverview("text")).rejects.toThrow(PublicationSafetyError);
    expect(postFn).not.toHaveBeenCalled();
  });

  it("refuses any channel other than the hard-locked destination", async () => {
    const postFn = okPostFn();
    const publisher = createPublisher(postFn, "C0SOMEOTHER");

    await expect(publisher.postOverview("text")).rejects.toThrow(/only permitted destination/);
    expect(postFn).not.toHaveBeenCalled();
  });
});

describe("createPublisher — threading", () => {
  it("posts issue details as replies carrying the overview thread_ts", async () => {
    const postFn = okPostFn("1700000000.000200");
    const publisher = createPublisher(postFn, DEST);

    await publisher.postThreadReply("issue text", "1700000000.000100");

    const request = vi.mocked(postFn).mock.calls[0]?.[0] as SlackPostRequest;
    expect(request.thread_ts).toBe("1700000000.000100");
    expect(request.channel).toBe(DEST);
  });

  it("refuses to post an issue detail without a thread_ts", async () => {
    const postFn = okPostFn();
    const publisher = createPublisher(postFn, DEST);

    await expect(publisher.postThreadReply("issue text", "")).rejects.toThrow(PublicationSafetyError);
    await expect(publisher.postThreadReply("issue text", "")).rejects.toThrow(/top-level message/);
    expect(postFn).not.toHaveBeenCalled();
  });
});

describe("createPublisher — response validation", () => {
  it("aborts when Slack does not return ok", async () => {
    const publisher = createPublisher(async () => ({ ok: false, ts: "123" }), DEST);
    await expect(publisher.postOverview("text")).rejects.toThrow(SlackPublishError);
  });

  it("aborts when Slack returns no usable ts", async () => {
    const publisher = createPublisher(async () => ({ ok: true }), DEST);
    await expect(publisher.postOverview("text")).rejects.toThrow(/no usable ts/);
  });

  it("aborts on an empty ts", async () => {
    const publisher = createPublisher(async () => ({ ok: true, ts: "" }), DEST);
    await expect(publisher.postOverview("text")).rejects.toThrow(SlackPublishError);
  });
});

describe("Slack retry classification", () => {
  it("treats SDK rate-limit errors as retryable", () => {
    expect(isRetryableSlackError({ code: "slack_webapi_rate_limited_error" })).toBe(true);
    expect(isRetryableSlackError({ data: { error: "ratelimited" } })).toBe(true);
  });

  it("treats 5xx as retryable", () => {
    expect(isRetryableSlackError({ status: 503 })).toBe(true);
  });

  it("does not retry validation errors", () => {
    expect(isRetryableSlackError({ data: { error: "channel_not_found" } })).toBe(false);
    expect(isRetryableSlackError({ data: { error: "invalid_auth" } })).toBe(false);
    expect(isRetryableSlackError({ data: { error: "not_in_channel" } })).toBe(false);
    expect(isRetryableSlackError({ status: 400 })).toBe(false);
    expect(isRetryableSlackError(new Error("boom"))).toBe(false);
  });

  it("reads Retry-After from either shape", () => {
    expect(retryAfterMs({ retryAfter: 3 })).toBe(3000);
    expect(retryAfterMs({ data: { retry_after: 5 } })).toBe(5000);
    expect(retryAfterMs({})).toBeUndefined();
  });
});

describe("withSlackRetry", () => {
  it("retries a rate limit and then succeeds", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        throw { code: "slack_webapi_rate_limited_error", retryAfter: 1 };
      }
      return "ok";
    });

    const result = await withSlackRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 }, noSleep);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("waits for Retry-After when Slack supplies it", async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    await withSlackRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw { code: "slack_webapi_rate_limited_error", retryAfter: 2 };
        }
        return "ok";
      },
      { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 60_000 },
      sleep,
    );
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("caps a very large Retry-After", async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    await withSlackRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw { code: "slack_webapi_rate_limited_error", retryAfter: 9999 };
        }
        return "ok";
      },
      { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5000 },
      sleep,
    );
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it("stops after the bounded attempt count rather than retrying forever", async () => {
    const fn = vi.fn(async () => {
      throw { code: "slack_webapi_rate_limited_error" };
    });

    await expect(withSlackRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 }, noSleep)).rejects.toBeDefined();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-retryable error", async () => {
    const fn = vi.fn(async () => {
      throw { data: { error: "channel_not_found" } };
    });

    await expect(withSlackRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 }, noSleep)).rejects.toBeDefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("keeps the default attempt count small", () => {
    expect(DEFAULT_SLACK_RETRY_OPTIONS.maxAttempts).toBeLessThanOrEqual(3);
  });
});
