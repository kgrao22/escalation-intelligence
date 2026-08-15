import { describe, expect, it } from "vitest";
import { displayNameFor, hasShortDisplayName } from "../../src/slackReport/displayNames.js";
import {
  automationLabel,
  confidenceLine,
  evidenceLinks,
  formatDateRange,
  formatShortDate,
  pluraliseOccurrences,
  priorityEmoji,
  priorityLabel,
  shouldShowAutomationIdea,
  statusLine,
} from "../../src/slackReport/formatters.js";

describe("displayNameFor", () => {
  it("shortens each of the seven known persisted names", () => {
    const cases: Array<[string, string]> = [
      ["Policy cancellation state not fully synchronized across backend systems", "Policy cancellation state sync"],
      [
        "Overly strict document validation blocks email delivery for valid transactions missing insurer-unavailable documents",
        "Policy document validation blocks email",
      ],
      ["Payment link expiration before renewal due date processing window", "Renewal payment link expiry"],
      ["Email synchronization failure to downstream CRM and case management systems", "Email → CRM sync failure"],
      ["Missing automatic quote ID generation in endorsement processing workflow", "Endorsement quote ID generation"],
      [
        "Policy documents email sent without required attachments due to race condition in document upload workflow",
        "Policy document delivery race condition",
      ],
      ["Invoice GST calculation omits GST for certain fee components", "Invoice GST calculation"],
    ];

    for (const [persisted, expected] of cases) {
      expect(displayNameFor(persisted)).toBe(expected);
    }
  });

  it("keeps short names within roughly 4-9 words", () => {
    const shortened = displayNameFor(
      "Overly strict document validation blocks email delivery for valid transactions missing insurer-unavailable documents",
    );
    expect(shortened.split(/\s+/).length).toBeLessThanOrEqual(9);
  });

  it("falls back to the unchanged name for an unknown group", () => {
    const unknown = "Some entirely new recurring issue discovered next quarter";
    expect(displayNameFor(unknown)).toBe(unknown);
  });

  it("never truncates an unknown name mid-sentence", () => {
    const unknown = "A very long unfamiliar recurring issue name that has no mapping entry at all";
    expect(displayNameFor(unknown)).not.toContain("…");
    expect(displayNameFor(unknown)).toBe(unknown);
  });

  it("handles a null name", () => {
    expect(displayNameFor(null)).toBe("(unnamed recurring issue)");
  });

  it("reports whether a short form exists", () => {
    expect(hasShortDisplayName("Invoice GST calculation omits GST for certain fee components")).toBe(true);
    expect(hasShortDisplayName("Unknown issue")).toBe(false);
    expect(hasShortDisplayName(null)).toBe(false);
  });
});

describe("priority formatting", () => {
  it("maps each priority to its indicator", () => {
    expect(priorityEmoji("high")).toBe("🔴");
    expect(priorityEmoji("medium")).toBe("🟠");
    expect(priorityEmoji("low")).toBe("🟢");
  });

  it("labels priorities in plain English", () => {
    expect(priorityLabel("high")).toBe("High priority");
    expect(priorityLabel("low")).toBe("Low priority");
  });
});

describe("automation formatting", () => {
  it("labels each opportunity level", () => {
    expect(automationLabel("high")).toBe("Automation: High");
    expect(automationLabel("medium")).toBe("Automation: Medium");
    expect(automationLabel("low")).toBe("Automation: Low");
    expect(automationLabel("not_applicable")).toBe("Automation: N/A");
  });

  it("never renders a raw enum with underscores", () => {
    expect(automationLabel("not_applicable")).not.toContain("_");
  });

  it("shows an idea only for high and medium", () => {
    expect(shouldShowAutomationIdea("high")).toBe(true);
    expect(shouldShowAutomationIdea("medium")).toBe(true);
    expect(shouldShowAutomationIdea("low")).toBe(false);
    expect(shouldShowAutomationIdea("not_applicable")).toBe(false);
  });
});

describe("statusLine", () => {
  const posture = (over: Partial<Parameters<typeof statusLine>[0]> = {}) => ({
    unresolvedCount: 0,
    workaroundCount: 0,
    resolvedCount: 0,
    openCount: 0,
    hasUnresolvedOccurrences: false,
    hasWorkaroundOccurrences: false,
    hasOpenOccurrences: false,
    fullyResolved: false,
    ...over,
  });

  it("renders workaround-only openness", () => {
    expect(
      statusLine(posture({ workaroundCount: 2, openCount: 2, hasOpenOccurrences: true }), 3),
    ).toBe("Open: 2 workaround");
  });

  it("renders mixed unresolved and workaround", () => {
    expect(
      statusLine(
        posture({ unresolvedCount: 1, workaroundCount: 1, openCount: 2, hasOpenOccurrences: true }),
        2,
      ),
    ).toBe("Open: 1 unresolved, 1 workaround");
  });

  it("renders fully resolved", () => {
    expect(statusLine(posture({ resolvedCount: 2, fullyResolved: true }), 2)).toBe("Resolved");
  });

  it("renders investigating when nothing is open and nothing is confirmed resolved", () => {
    expect(statusLine(posture(), 2)).toBe("Investigating");
  });

  it("never emits raw enum names", () => {
    const line = statusLine(posture({ unresolvedCount: 1, openCount: 1, hasOpenOccurrences: true }), 1);
    expect(line).not.toContain("_");
  });
});

describe("date formatting", () => {
  it("formats a short UTC date", () => {
    expect(formatShortDate("2026-06-12T00:00:00.000Z")).toBe("Jun 12");
  });

  it("formats a range", () => {
    expect(formatDateRange("2026-06-12T00:00:00.000Z", "2026-07-22T00:00:00.000Z")).toBe("Jun 12 → Jul 22");
  });

  it("collapses a same-day range to one date", () => {
    expect(formatDateRange("2026-06-12T01:00:00.000Z", "2026-06-12T09:00:00.000Z")).toBe("Jun 12");
  });

  it("returns null when both dates are missing", () => {
    expect(formatDateRange(null, null)).toBeNull();
  });

  it("returns whichever date is available", () => {
    expect(formatDateRange(null, "2026-07-22T00:00:00.000Z")).toBe("Jul 22");
  });
});

describe("confidenceLine", () => {
  it("renders a percentage", () => {
    expect(confidenceLine(0.92)).toBe("Confidence: 92%");
  });

  it("warns below 0.80", () => {
    expect(confidenceLine(0.72)).toBe("Confidence: 72% ⚠️");
  });

  it("does not warn exactly at 0.80", () => {
    expect(confidenceLine(0.8)).toBe("Confidence: 80%");
  });

  it("warns just below the threshold", () => {
    expect(confidenceLine(0.799)).toContain("⚠️");
  });
});

describe("evidenceLinks", () => {
  it("renders Slack mrkdwn links", () => {
    const links = evidenceLinks([
      { permalink: "https://slack.example/p1" },
      { permalink: "https://slack.example/p2" },
    ]);
    expect(links).toBe("<https://slack.example/p1|Occurrence 1> · <https://slack.example/p2|Occurrence 2>");
  });

  it("skips occurrences without a permalink and renumbers", () => {
    const links = evidenceLinks([
      { permalink: null },
      { permalink: "https://slack.example/p2" },
    ]);
    expect(links).toBe("<https://slack.example/p2|Occurrence 1>");
  });

  it("returns null when nothing is linkable", () => {
    expect(evidenceLinks([{ permalink: null }])).toBeNull();
    expect(evidenceLinks([])).toBeNull();
  });
});

describe("pluraliseOccurrences", () => {
  it("pluralises correctly", () => {
    expect(pluraliseOccurrences(1)).toBe("1 occurrence");
    expect(pluraliseOccurrences(3)).toBe("3 occurrences");
  });
});
