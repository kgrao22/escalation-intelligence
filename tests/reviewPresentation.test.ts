import { describe, expect, it } from "vitest";
import {
  formatSystems,
  SYSTEM_SEPARATOR,
  MAX_DISPLAYED_SYSTEMS,
  normalizeSystemLabels,
  PROPOSAL_MAX_LENGTH,
  truncateForSlack,
} from "../src/reviewPublishing/presentation.js";

describe("truncateForSlack — abbreviation safety", () => {
  it("never splits inside e.g.", () => {
    const text =
      "Implement a scheduled job that regenerates payment links when they expire before the renewal start date (e.g. 45 days). It then notifies the customer.";
    const result = truncateForSlack(text, 120);
    expect(result).not.toContain("e. g");
    expect(result).not.toMatch(/e\.$/);
    if (result.includes("e.g.")) {
      expect(result).toContain("e.g.");
    }
  });

  it("never splits inside i.e.", () => {
    const text =
      "Restrict the transition to permitted states only, i.e. cancelled to active, and reject everything else outright. A second sentence follows here.";
    const result = truncateForSlack(text, 130);
    expect(result).not.toContain("i. e");
    expect(result).not.toMatch(/i\.$/);
  });

  it("does not treat etc. or vs. as a sentence end", () => {
    const text = `Covers dashboard, billing, CRM, etc. and compares old vs. new values before writing. ${"x".repeat(400)}`;
    const result = truncateForSlack(text, 90);
    expect(result).not.toMatch(/etc\.$/);
    expect(result).not.toMatch(/vs\.$/);
  });

  it("keeps a decimal number intact", () => {
    const text = `Retry with a backoff factor of 1.5 seconds between attempts and stop after five tries. ${"y".repeat(400)}`;
    const result = truncateForSlack(text, 60);
    expect(result).not.toMatch(/1\.$/);
  });

  it("cuts at a real sentence boundary in ordinary two-sentence text", () => {
    const text = `Build a guarded admin tool that validates input. ${"z".repeat(400)}`;
    expect(truncateForSlack(text, 120)).toBe("Build a guarded admin tool that validates input.");
  });

  it("returns text shorter than the limit unchanged", () => {
    expect(truncateForSlack("Short proposal.", 200)).toBe("Short proposal.");
    expect(truncateForSlack("No trailing period", 200)).toBe("No trailing period");
  });

  it("normalises internal whitespace without altering wording", () => {
    expect(truncateForSlack("Build   a\n\ntool.", 200)).toBe("Build a tool.");
  });

  it("never truncates mid-word when no sentence boundary fits", () => {
    const text = "Supercalifragilistic engineering workflow automation platform integration layer rebuild programme";
    const result = truncateForSlack(text, 40);
    expect(result.endsWith("…")).toBe(true);
    const body = result.slice(0, -1);
    // Every rendered word must appear whole in the source.
    for (const word of body.split(" ")) {
      expect(text.split(" ")).toContain(word);
    }
  });

  it("never ends on a dangling abbreviation fragment", () => {
    const text = `Apply the change atomically across systems (e.g. dashboard auth, billing) and confirm. ${"w".repeat(400)}`;
    for (let limit = 30; limit <= 120; limit += 7) {
      const result = truncateForSlack(text, limit);
      expect(result, `limit ${limit}`).not.toMatch(/\b[a-z]\.$/i);
      expect(result, `limit ${limit}`).not.toContain("e. g");
    }
  });

  it("is deterministic and defaults to the documented cap", () => {
    const text = "A".repeat(1000);
    expect(truncateForSlack(text)).toEqual(truncateForSlack(text));
    expect(truncateForSlack(text).length).toBeLessThanOrEqual(PROPOSAL_MAX_LENGTH + 1);
  });
});

describe("normalizeSystemLabels", () => {
  it("removes exact and case-insensitive duplicates", () => {
    expect(normalizeSystemLabels(["Payments integration", "Payments integration", "payments INTEGRATION"])).toEqual([
      "Payments integration",
    ]);
  });

  it("normalises whitespace", () => {
    expect(normalizeSystemLabels(["  Billing   Flow ", "Billing Flow"])).toEqual(["Billing Flow"]);
  });

  it("collapses a substring variant, keeping the more specific label", () => {
    expect(normalizeSystemLabels(["Payments integration", "Payments integration / payment marking system"])).toEqual([
      "Payments integration / payment marking system",
    ]);
  });

  it("collapses comma and slash variants of the same system", () => {
    const result = normalizeSystemLabels([
      "Payments integration",
      "Payments integration, payment processing",
      "Payments integration / payment marking system",
    ]);
    expect(result).not.toContain("Payments integration");
    expect(result.length).toBeLessThan(3);
  });

  it("collapses reordered wording that plain substring matching would miss", () => {
    // "Payments integration" is not a substring of the longer label, but its
    // significant tokens are a subset.
    expect(
      normalizeSystemLabels(["Gateway integration", "Payment processing integration with the gateway"]),
    ).toEqual(["Payment processing integration with the gateway"]);
  });

  it("keeps genuinely distinct systems", () => {
    const result = normalizeSystemLabels(["Billing Flow", "Helpdesk integration", "Records database"]);
    expect(result).toHaveLength(3);
  });

  it("prefers the most specific label when token sets are equal", () => {
    expect(normalizeSystemLabels(["Gateway payment", "payment Gateway integration extra"])).toEqual([
      "payment Gateway integration extra",
    ]);
  });

  it("orders deterministically regardless of input order", () => {
    const input = ["Billing Flow", "Helpdesk integration", "Records database", "Dashboard"];
    expect(normalizeSystemLabels(input)).toEqual(normalizeSystemLabels([...input].reverse()));
  });

  it("invents no labels: every survivor came from the source", () => {
    const input = ["Payments integration", "Payments integration, payment processing", "Billing Flow"];
    for (const label of normalizeSystemLabels(input)) {
      expect(input.map((s) => s.trim())).toContain(label);
    }
  });

  it("drops empty entries", () => {
    expect(normalizeSystemLabels(["", "   ", "Dashboard"])).toEqual(["Dashboard"]);
  });
});

describe("formatSystems", () => {
  it("shows at most three systems", () => {
    const result = formatSystems(["Alpha one", "Bravo two", "Charlie three", "Delta four", "Echo five"]);
    expect(result.split(" +")[0]?.split(SYSTEM_SEPARATOR)).toHaveLength(MAX_DISPLAYED_SYSTEMS);
  });

  it("summarises the remainder as +N more", () => {
    expect(formatSystems(["Alpha one", "Bravo two", "Charlie three", "Delta four", "Echo five"])).toMatch(
      /\+2 more$/,
    );
  });

  it("omits the suffix when three or fewer remain", () => {
    expect(formatSystems(["Billing Flow", "Records database"])).toBe(`Billing Flow${SYSTEM_SEPARATOR}Records database`);
    expect(formatSystems(["Billing Flow", "Records database"])).not.toContain("more");
  });

  it("counts the remainder AFTER collapsing duplicates", () => {
    // Four labels, two of which collapse into one, leaves three — no suffix.
    const result = formatSystems([
      "Payments integration",
      "Payments integration, payment processing",
      "Billing Flow",
      "Records database",
    ]);
    expect(result).not.toContain("more");
    // Split on the middot: labels may themselves contain commas.
    expect(result.split(SYSTEM_SEPARATOR)).toHaveLength(3);
  });

  it("returns an empty string when there is nothing to show", () => {
    expect(formatSystems([])).toBe("");
    expect(formatSystems(["  "])).toBe("");
  });

  it("is deterministic", () => {
    const input = ["Charlie three", "Alpha one", "Bravo two", "Delta four"];
    expect(formatSystems(input)).toBe(formatSystems([...input].reverse()));
  });

  it("cleans up the real noisy Stripe list from the 180-day report", () => {
    const real = [
      "Payment processing integration with the gateway",
      "Billing Flow",
      "Payments integration",
      "Payments integration / payment marking system",
      "Payments integration, payment processing",
    ];
    const result = formatSystems(real);
    expect(result).not.toBe(real.join(SYSTEM_SEPARATOR));
    // Bare "Payments integration" is subsumed by the more specific variants.
    expect(result.split(SYSTEM_SEPARATOR).map((s) => s.replace(/ \+\d+ more$/, ""))).not.toContain("Payments integration");
    expect(result.length).toBeLessThan(real.join(SYSTEM_SEPARATOR).length);
  });
});

import { reviewPeriodLabel, reviewTitle } from "../src/review/displayNames.js";

describe("review title derives from the window", () => {
  it("renders 12 Month Review for a 365-day window", () => {
    expect(reviewTitle(365)).toBe("Escalation Intelligence — 12 Month Review");
  });

  it("preserves 6 Month Review for the published 180-day behaviour", () => {
    expect(reviewTitle(180)).toBe("Escalation Intelligence — 6 Month Review");
  });

  it("handles other windows without a special case", () => {
    expect(reviewPeriodLabel(90)).toBe("3 Month Review");
    expect(reviewPeriodLabel(30)).toBe("30 Day Review");
    expect(reviewPeriodLabel(60)).toBe("2 Month Review");
  });

  it("degrades safely when the window is unknown", () => {
    expect(reviewPeriodLabel(null)).toBe("Escalation Review");
    expect(reviewPeriodLabel(0)).toBe("Escalation Review");
  });
});

import { findUnsupportedClaims } from "../src/reviewPublishing/slackSafeCopy.js";

describe("duration claims: savings vs design parameters", () => {
  it.each([
    "saves ~30 minutes of manual backend work",
    "will eliminate ~30 minutes of manual manipulation",
    "could save ~15–30 minutes per occurrence",
    "Staff time savings of ~2–4 hours",
    "reduces 45 minutes of triage",
  ])("flags the savings claim: %s", (text) => {
    expect(findUnsupportedClaims(text)).toContain("hours or minutes saved");
  });

  it.each([
    "Implement a 24-hour read-only window before applying the change",
    "no two sends to the same customer within 4 hours",
    "retry with exponential backoff for up to 15 minutes",
    "provides a rollback function within a bounded window of 1 hour",
  ])("permits the technical design parameter: %s", (text) => {
    expect(findUnsupportedClaims(text)).not.toContain("hours or minutes saved");
  });

  it("still flags unambiguous rate and monetary claims anywhere", () => {
    expect(findUnsupportedClaims("13 manual transitions per month")).toContain("rate per time unit");
    expect(findUnsupportedClaims("saves $40,000 annually")).toContain("monetary estimate");
  });
});

import { describeAutomationStatus, slackDisplayTitle } from "../src/reviewPublishing/presentation.js";

describe("slackDisplayTitle", () => {
  it("keeps a specific classification label", () => {
    expect(
      slackDisplayTitle("Customer identity & email updates", "customer_identity_update", "Update an email."),
    ).toBe("Customer identity & email updates");
  });

  it("derives a distinct title when the label is a generic bucket", () => {
    const titles = [
      slackDisplayTitle(
        "Backend operational corrections",
        "manual_backend_correction",
        "Manually extend payment link expiry in backend systems when link expires before payment.",
      ),
      slackDisplayTitle(
        "Backend operational corrections",
        "manual_backend_correction",
        "Manually mark payment transactions as paid and update policy state to purchased in backend systems.",
      ),
      slackDisplayTitle(
        "Backend operational corrections",
        "manual_backend_correction",
        "Manually split a multi-policy program into separate programs to work around payment failures.",
      ),
      slackDisplayTitle(
        "Backend operational corrections",
        "manual_backend_correction",
        "Manually identify and remove duplicate Stripe customer accounts to unblock renewal notices.",
      ),
    ];
    // The four generic items must now be mutually distinguishable.
    expect(new Set(titles).size).toBe(4);
    for (const title of titles) {
      expect(title).not.toBe("Backend operational corrections");
    }
    expect(titles[0]).toBe("Extend payment link expiry");
  });

  it("strips a leading adverb and cuts before the qualifying clause", () => {
    expect(
      slackDisplayTitle("Account data updates", "account_data_update", "Manually correct policy dates that were bound incorrectly."),
    ).toBe("Correct policy dates");
  });

  it("falls back to the label when no usable phrase exists", () => {
    expect(slackDisplayTitle("Other operational work", "other_operational_workflow", "Fix it.")).toBe(
      "Other operational work",
    );
  });

  it("is deterministic", () => {
    const args = ["Backend operational corrections", "manual_backend_correction", "Manually extend payment link expiry in backend systems."] as const;
    expect(slackDisplayTitle(...args)).toBe(slackDisplayTitle(...args));
  });
});

describe("describeAutomationStatus reconciles to the occurrence count", () => {
  it("all manual", () => {
    expect(describeAutomationStatus({ manual: 8 }, 8)).toBe("all 8 manual");
  });

  it("manual plus unknown never claims 'all N manual'", () => {
    expect(describeAutomationStatus({ manual: 3, unknown: 5 }, 8)).toBe("3 of 8 manual, 5 unclear");
  });

  it("manual plus partially automated", () => {
    expect(describeAutomationStatus({ manual: 6, partially_automated: 2 }, 8)).toBe("6 manual, 2 partly automated");
  });

  it("all unknown", () => {
    expect(describeAutomationStatus({ unknown: 4 }, 4)).toBe("automation status unclear");
  });

  it("never states a manual count exceeding the occurrences shown", () => {
    const text = describeAutomationStatus({ manual: 3, unknown: 5 }, 8);
    expect(text).not.toMatch(/all 3 manual/);
    expect(text).toContain("of 8");
  });

  it("handles an empty breakdown", () => {
    expect(describeAutomationStatus({}, 0)).toBe("automation status unclear");
  });
});

describe("generated titles are grammatically complete", () => {
  it("does not stop mid-phrase after a conjunction", () => {
    const title = slackDisplayTitle(
      "Backend operational corrections",
      "manual_backend_correction",
      "Manually mark payment transactions as paid and update policy state to purchased in backend systems.",
    );
    expect(title).toBe("Mark payment transactions as paid and update policy state");
    expect(title.split(" ").length).toBeLessThanOrEqual(9);
  });

  it.each(["and", "or", "to", "for", "with"])("never ends on the continuation word '%s'", (word) => {
    const title = slackDisplayTitle(
      "Backend operational corrections",
      "manual_backend_correction",
      `Manually reconcile one two three four five six ${word} seven eight nine ten.`,
    );
    expect(title.toLowerCase().endsWith(` ${word}`)).toBe(false);
  });

  it("respects the hard ceiling of 9 words", () => {
    const title = slackDisplayTitle(
      "Backend operational corrections",
      "manual_backend_correction",
      "Manually alpha bravo charlie delta echo and foxtrot golf hotel india juliet kilo.",
    );
    expect(title.split(" ").length).toBeLessThanOrEqual(9);
  });

  it("still stops at the soft cap when the phrase is already complete", () => {
    const title = slackDisplayTitle(
      "Backend operational corrections",
      "manual_backend_correction",
      "Manually delete duplicate Stripe customer accounts blocking renewal notice delivery entirely.",
    );
    expect(title.split(" ").length).toBeLessThanOrEqual(7);
  });
});
