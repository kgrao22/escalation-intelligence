import { describe, expect, it, vi } from "vitest";
import type { ReviewArtifact } from "../src/persistence/reviewArtifactOutput.js";
import {
  buildReviewPreview,
  REVIEW_REPLY_SECTIONS,
  type ReviewPreviewArtifact,
} from "../src/reviewPublishing/buildReviewPreview.js";
import { formatSystems } from "../src/reviewPublishing/presentation.js";
import {
  buildPublishedIndex,
  isPublicationComplete,
  runReviewPublication,
  type PriorReviewPublication,
} from "../src/reviewPublishing/runReviewPublication.js";
import {
  assertNoUnsupportedExtrapolation,
  buildSlackSafeBenefit,
  describeWorkflowCandidates,
  findUnsupportedClaims,
  UnsupportedClaimError,
} from "../src/reviewPublishing/slackSafeCopy.js";
import type { SlackPostFn } from "../src/slackPublishing/client.js";
import {
  EXPECTED_DESTINATION_CHANNEL_ID,
  FORBIDDEN_SOURCE_CHANNEL_ID,
  PublicationSafetyError,
} from "../src/slackPublishing/safety.js";

const LINKS = ["https://example.slack.com/archives/C0SOURCE0000/p1", "https://example.slack.com/archives/C0SOURCE0000/p2"];

function review(overrides: Partial<ReviewArtifact> = {}): ReviewArtifact {
  return {
    metadata: {
      windowTag: "180d",
      generatedAt: "2026-08-14T00:00:00.000Z",
      extractionsInputFile: "e.json",
      workflowClustersInputFile: "c.json",
      workflowRecommendationsInputFile: "r.json",
      technicalReportInputFile: "t.json",
      technicalRecurrenceAvailable: true,
      externalApiCalls: 0,
    },
    overview: {
      windowTag: "180d", windowDays: 180, threadsAnalysed: 297, technicalEscalations: 124,
      workflowCandidates: 142, technicalAndWorkflow: 51, workflowOnly: 91, technicalOnly: 73,
      neither: 82, recurringWorkflowClusters: 7, singletonWorkflows: 94, distinctActionableThreads: 215,
      coverageFrom: "2026-02-17T00:00:00.000Z", coverageTo: "2026-08-12T00:00:00.000Z",
    },
    automationOpportunities: [
      {
        rank: 1, clusterId: "wf-a", title: "Customer identity & email updates", occurrenceCount: 20,
        classificationKey: "customer_identity_update",
        representativeStatement: "Update a customer's email address across backend systems.",
        score: 83.65, recommendedAction: "internal_admin_tool", priority: "high", feasibility: "high",
        patternSummary: "Update a customer's email across systems.",
        proposedAutomation: "Build a guarded tool. It validates and propagates. It logs everything.",
        guardrails: ["Role-based access", "Audit log", "Rollback window", "Extra guardrail"],
        // Deliberately full of the exact unsupported claims seen in the real run.
        expectedBenefit:
          "Eliminate 13 manual state transitions per month, saving ~1-2 hours per week and reducing time-to-restore from hours to minutes.",
        evidenceLinks: LINKS,
      },
    ],
    recurringWorkflows: [
      {
        clusterId: "wf-a", title: "Customer identity & email updates", classification: "Customer identity & email updates",
        classificationKey: "customer_identity_update",
        occurrenceCount: 20, firstSeen: "2026-02-17T00:00:00.000Z", lastSeen: "2026-08-12T00:00:00.000Z",
        automationStatusBreakdown: { manual: 15, unknown: 3, partially_automated: 2 },
        workflowOnlyCount: 19, technicalWorkflowCount: 1,
        representativeStatement: "Update a customer's email address across backend systems.",
        evidenceLinks: LINKS,
      },
    ],
    technicalIssues: {
      available: true, message: "Recurring technical issues across the 180d window.", windowDays: 180,
      issues: [
        {
          name: "Multiple Stripe customer records", occurrenceCount: 4, openOccurrences: 2,
          fullyResolved: false, peakSeverity: "high",
          affectedSystems: ["Stripe integration", "Stripe integration, payment processing", "Renewal Flow"],
          remediation: "Deduplicate at customer creation and establish a canonical Stripe mapping.",
          evidenceLinks: LINKS,
        },
      ],
    },
    longTail: {
      singletonWorkflowCount: 94,
      topClassifications: [{ classification: "manual_backend_correction", label: "Backend operational corrections", count: 29 }],
      note: "These workflows were each requested once in the period.",
    },
    nextActions: [{ order: 1, action: "Build an internal admin tool for customer identity", basis: "20 occurrences" }],
    rendered: { plainText: "", slackMrkdwn: { overview: "", replies: [] } },
    ...overrides,
  };
}

const AT = new Date("2026-08-14T12:00:00.000Z");

describe("Slack-safe wording", () => {
  it("describes the population as workflow candidates, not manual requests", () => {
    expect(describeWorkflowCandidates(142)).toBe("142 workflow candidates identified");
    const preview = buildReviewPreview(review(), "review.json", AT);
    const parent = preview.messages[0]?.text ?? "";
    // The parent describes the population as candidates, never as "manual requests".
    expect(parent).toContain("142* workflow candidates");
    expect(parent).not.toContain("manual workflow requests");
  });

  it("builds a benefit only from stored counts and dates", () => {
    const benefit = buildSlackSafeBenefit({
      occurrenceCount: 20,
      firstSeen: "2026-02-17T00:00:00.000Z",
      lastSeen: "2026-08-12T00:00:00.000Z",
      automationStatusBreakdown: { manual: 15, partially_automated: 2 },
      windowDays: 180,
    });
    expect(benefit).toContain("observed 20 times");
    expect(benefit).toContain("6 months");
    expect(benefit).toContain("176 days");
    expect(benefit).toContain("15 occurrences were fully manual and 2 partly automated");
    expect(findUnsupportedClaims(benefit)).toEqual([]);
  });

  it("does not alter analytical values", () => {
    const source = review();
    const preview = buildReviewPreview(source, "review.json", AT);

    expect(preview.summary.threadsAnalysed).toBe(source.overview.threadsAnalysed);
    expect(preview.summary.technicalEscalations).toBe(source.overview.technicalEscalations);
    expect(preview.summary.workflowCandidates).toBe(source.overview.workflowCandidates);
    expect(preview.summary.recurringWorkflowClusters).toBe(source.overview.recurringWorkflowClusters);
    expect(preview.summary.singletonWorkflows).toBe(source.overview.singletonWorkflows);
    // Rank, occurrence count and evidence links survive untouched.
    expect(preview.messages[1]?.text).toContain("*Customer identity & email updates*");
    expect(preview.messages[1]?.text).toContain("20 occurrences");
    for (const link of LINKS) {
      expect(preview.messages[1]?.text).toContain(link);
    }
  });

  it("leaves the review artifact itself unmodified (provenance preserved)", () => {
    const source = review();
    const before = JSON.parse(JSON.stringify(source));
    buildReviewPreview(source, "review.json", AT);
    expect(source).toEqual(before);
    expect(source.automationOpportunities[0]?.expectedBenefit).toContain("13 manual state transitions per month");
  });
});

describe("unsupported extrapolation is excluded", () => {
  it.each([
    ["60-100 operator hours annually", "operator-capacity estimate"],
    ["13 manual state transitions per month", "rate per time unit"],
    ["~36 automations per quarter", "rate per time unit"],
    ["two manual backend corrections per week", "rate per time unit"],
    ["saves ~1-2 hours of backend work", "hours or minutes saved"],
    ["reducing time-to-restore from hours to minutes", "time-to-x reduction claim"],
    ["eliminate two corrections per week (extrapolated)", "explicit extrapolation"],
    ["saves $40,000 in cost savings", "monetary estimate"],
  ])("detects %s", (text, label) => {
    expect(findUnsupportedClaims(text)).toContain(label);
    expect(() => assertNoUnsupportedExtrapolation(text, "test")).toThrow(UnsupportedClaimError);
  });

  it("keeps the model's ROI prose out of every Slack message", () => {
    const preview = buildReviewPreview(review(), "review.json", AT);
    for (const message of preview.messages) {
      expect(findUnsupportedClaims(message.text), `message ${message.index}`).toEqual([]);
      expect(message.text).not.toContain("13 manual state transitions");
      expect(message.text).not.toContain("1-2 hours");
    }
  });

  it("fails the build rather than silently stripping a bad claim", () => {
    // Injected where Slack copy actually renders it — the proposal line.
    const base = review();
    const first = base.automationOpportunities[0];
    if (!first) {
      throw new Error("fixture must define an opportunity");
    }
    const bad = review({
      automationOpportunities: [
        { ...first, proposedAutomation: "Saves roughly 60-100 operator hours annually." },
      ],
    });
    expect(() => buildReviewPreview(bad, "review.json", AT)).toThrow(UnsupportedClaimError);
  });

  it("accepts an evidence-grounded benefit", () => {
    expect(() =>
      assertNoUnsupportedExtrapolation(
        "Removes a workflow observed 20 times in 6 months, recurring across 176 days.",
        "test",
      ),
    ).not.toThrow();
  });
});

describe("preview structure", () => {
  const preview = buildReviewPreview(review(), "review.json", AT);

  it("plans exactly 1 parent and 4 replies", () => {
    expect(preview.messages).toHaveLength(5);
    expect(preview.messages.filter((m) => m.kind === "parent")).toHaveLength(1);
    expect(preview.messages.filter((m) => m.kind === "reply")).toHaveLength(4);
    expect(preview.messages[0]?.kind).toBe("parent");
    expect(preview.messages.slice(1).map((m) => m.title)).toEqual([...REVIEW_REPLY_SECTIONS]);
  });

  it("does not emit one reply per issue", () => {
    const many = review({
      automationOpportunities: Array.from({ length: 7 }, (_, i) => {
        const first = review().automationOpportunities[0];
        if (!first) {
          throw new Error("fixture must define an opportunity");
        }
        return { ...first, rank: i + 1, clusterId: `wf-${i}` };
      }),
    });
    expect(buildReviewPreview(many, "review.json", AT).messages).toHaveLength(5);
  });

  it("encodes the destination and its own format", () => {
    expect(preview.metadata.destinationChannelId).toBe(EXPECTED_DESTINATION_CHANNEL_ID);
    expect(preview.metadata.previewFormat).toBe("review-v1");
    expect(preview.metadata.reviewInputFile).toBe("review.json");
  });

  it("preserves evidence links to the source channel", () => {
    const all = preview.messages.map((m) => m.text).join("\n");
    expect(all).toContain("C0SOURCE0000");
  });

  it("collapses near-duplicate system names for readability only", () => {
    expect(formatSystems(["Stripe integration", "Stripe integration, payment processing", "Renewal Flow"])).toBe(
      "Stripe integration, payment processing · Renewal Flow",
    );
  });

  it("is deterministic for identical input", () => {
    expect(buildReviewPreview(review(), "review.json", AT)).toEqual(preview);
  });
});

function previewArtifact(overrides: Partial<ReviewPreviewArtifact["metadata"]> = {}): ReviewPreviewArtifact {
  const built = buildReviewPreview(review(), "review.json", AT);
  return { ...built, metadata: { ...built.metadata, ...overrides } };
}

describe("publisher safety", () => {
  it("posts the parent before any reply", async () => {
    const order: Array<string | undefined> = [];
    const postFn: SlackPostFn = vi.fn(async ({ thread_ts }) => {
      order.push(thread_ts);
      return { ts: `ts-${order.length}` };
    });

    await runReviewPublication({ preview: previewArtifact(), postFn });
    expect(order[0]).toBeUndefined(); // parent has no thread_ts
    expect(order.slice(1).every((ts) => ts === "ts-1")).toBe(true);
  });

  it("refuses a preview targeting the source channel", async () => {
    const postFn: SlackPostFn = vi.fn();
    await expect(
      runReviewPublication({ preview: previewArtifact({ destinationChannelId: FORBIDDEN_SOURCE_CHANNEL_ID }), postFn }),
    ).rejects.toThrow(PublicationSafetyError);
    expect(postFn).not.toHaveBeenCalled();
  });

  it("refuses any channel other than the hard-locked destination", async () => {
    const postFn: SlackPostFn = vi.fn();
    await expect(
      runReviewPublication({ preview: previewArtifact({ destinationChannelId: "C0OTHER" }), postFn }),
    ).rejects.toThrow(/only C0DEST00000 is permitted/);
    expect(postFn).not.toHaveBeenCalled();
  });

  it("writes only to the destination channel", async () => {
    const channels: string[] = [];
    const postFn: SlackPostFn = vi.fn(async ({ channel }) => {
      channels.push(channel);
      return { ts: "1.1" };
    });
    await runReviewPublication({ preview: previewArtifact(), postFn });
    expect(new Set(channels)).toEqual(new Set([EXPECTED_DESTINATION_CHANNEL_ID]));
  });

  it("aborts without posting replies when the parent fails", async () => {
    const postFn: SlackPostFn = vi.fn(async () => {
      throw new Error("slack down");
    });
    const { results } = await runReviewPublication({ preview: previewArtifact(), postFn });
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("failed");
    expect(postFn).toHaveBeenCalledTimes(1);
  });
});

describe("resume and duplicate protection", () => {
  const preview = previewArtifact();

  function prior(indexes: number[], previewInputFile = "preview.json"): PriorReviewPublication {
    return {
      previewInputFile,
      parentTs: "ts-1",
      results: indexes.map((index) => ({
        index, kind: index === 1 ? ("parent" as const) : ("reply" as const),
        title: "t", status: "success" as const, slackTs: `ts-${index}`,
      })),
    };
  }

  it("does not repost messages that already succeeded", async () => {
    const published = buildPublishedIndex([prior([1, 2, 3])], "preview.json");
    const posted: number[] = [];
    const postFn: SlackPostFn = vi.fn(async ({ text }) => {
      posted.push(text.length);
      return { ts: "new" };
    });

    const { results } = await runReviewPublication({ preview, postFn, published, parentTs: "ts-1" });
    expect(results.filter((r) => r.status === "skipped")).toHaveLength(3);
    expect(postFn).toHaveBeenCalledTimes(2); // only messages 4 and 5
  });

  it("reports a fully published preview as complete", () => {
    const published = buildPublishedIndex([prior([1, 2, 3, 4, 5])], "preview.json");
    expect(isPublicationComplete(preview, published)).toBe(true);
  });

  it("does not treat a partially published preview as complete", () => {
    expect(isPublicationComplete(preview, buildPublishedIndex([prior([1, 2])], "preview.json"))).toBe(false);
  });

  it("ignores receipts belonging to a different preview file", () => {
    const published = buildPublishedIndex([prior([1, 2, 3, 4, 5], "some-other-preview.json")], "preview.json");
    expect(published.size).toBe(0);
    expect(isPublicationComplete(preview, published)).toBe(false);
  });
});

describe("legacy artifacts cannot be reused", () => {
  it("the publisher only consumes review-v1 previews", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/cli/intelligence-review-slack-publish.ts", "utf8");
    expect(source).toContain('preview.metadata?.previewFormat !== "review-v1"');
    expect(source).toContain("does not consume the legacy 90-day slack-preview format");
    // Resume state is read only from this publisher's own receipts.
    expect(source).toContain("^review-slack-publication-");
  });

  it("resolves its input by the review-specific prefix, not the legacy one", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/cli/intelligence-review-slack-publish.ts", "utf8");
    expect(source).toContain('prefix: "review-slack-preview"');
  });

  it("makes zero Slack calls without --publish", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/cli/intelligence-review-slack-publish.ts", "utf8");
    const guardAt = source.indexOf("if (!publishConfirmed)");
    const clientAt = source.indexOf("createSlackPostFn(token)");
    expect(guardAt).toBeGreaterThan(-1);
    expect(clientAt).toBeGreaterThan(guardAt);
    expect(source.slice(guardAt, clientAt)).toContain("Zero Slack API calls made");
    expect(source.slice(guardAt, clientAt)).toContain("return;");
  });

  it("the preview command never imports a Slack client", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const file of [
      "src/cli/intelligence-review-slack-preview.ts",
      "src/reviewPublishing/buildReviewPreview.ts",
      "src/reviewPublishing/slackSafeCopy.ts",
    ]) {
      const source = await readFile(file, "utf8");
      expect(source).not.toContain("@slack/web-api");
      expect(source).not.toMatch(/chat\.postMessage/);
    }
  });
});
