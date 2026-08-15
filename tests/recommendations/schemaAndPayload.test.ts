import { describe, expect, it } from "vitest";
import {
  AUTOMATION_OPPORTUNITIES,
  enforceAutomationIdeaInvariant,
  IssueRecommendationLLMOutputSchema,
  PRIORITIES,
  RECOMMENDED_ACTIONS,
  violatesAutomationIdeaInvariant,
  type IssueRecommendationLLMOutput,
} from "../../src/llm/schemas/issueRecommendation.js";
import {
  buildIssueRecommendationUserPrompt,
  ISSUE_RECOMMENDATION_PROMPT_VERSION,
  ISSUE_RECOMMENDATION_SYSTEM_PROMPT,
} from "../../src/llm/prompts/issueRecommendation.js";
import { buildRecommendationPayload } from "../../src/recommendations/buildPayload.js";
import { scrubIdentifiers } from "../../src/recommendations/scrubIdentifiers.js";
import { rankGroups } from "../../src/report/rankGroups.js";
import { analyzeGroup } from "../../src/report/analyzeGroup.js";
import { group, member } from "../report/analyzeGroup.test.js";

const ASOF = new Date("2026-08-10T00:00:00.000Z");

const valid: IssueRecommendationLLMOutput = {
  recommendedAction: "integration_or_data_sync_fix",
  priority: "high",
  engineeringRecommendation: "Add a reconciliation job.",
  rationale: "State diverges across systems.",
  evidenceSummary: "Three occurrences, two on workarounds.",
  automationOpportunity: "high",
  automationIdea: "Nightly reconciliation of cancellation state.",
  confidence: 0.8,
};

function rankedIssue(overrides: Parameters<typeof group>[0] = {}) {
  return rankGroups([analyzeGroup(group(overrides), ASOF)])[0]!;
}

describe("IssueRecommendationLLMOutputSchema", () => {
  it("exposes the full action enum", () => {
    expect(RECOMMENDED_ACTIONS).toEqual([
      "permanent_code_fix",
      "integration_or_data_sync_fix",
      "monitor_only",
      "improve_observability",
      "automate_manual_workaround",
      "configuration_or_process_fix",
      "investigate_root_cause",
      "documentation_or_training",
    ]);
  });

  it("exposes the priority and automation enums", () => {
    expect(PRIORITIES).toEqual(["high", "medium", "low"]);
    expect(AUTOMATION_OPPORTUNITIES).toEqual(["high", "medium", "low", "not_applicable"]);
  });

  it("accepts every valid action", () => {
    for (const recommendedAction of RECOMMENDED_ACTIONS) {
      expect(IssueRecommendationLLMOutputSchema.safeParse({ ...valid, recommendedAction }).success).toBe(true);
    }
  });

  it("accepts every valid priority and automation opportunity", () => {
    for (const priority of PRIORITIES) {
      expect(IssueRecommendationLLMOutputSchema.safeParse({ ...valid, priority }).success).toBe(true);
    }
    for (const automationOpportunity of AUTOMATION_OPPORTUNITIES) {
      expect(IssueRecommendationLLMOutputSchema.safeParse({ ...valid, automationOpportunity }).success).toBe(true);
    }
  });

  it("rejects unknown enum values", () => {
    expect(IssueRecommendationLLMOutputSchema.safeParse({ ...valid, recommendedAction: "rewrite_everything" }).success).toBe(false);
    expect(IssueRecommendationLLMOutputSchema.safeParse({ ...valid, priority: "urgent" }).success).toBe(false);
    expect(IssueRecommendationLLMOutputSchema.safeParse({ ...valid, automationOpportunity: "maybe" }).success).toBe(false);
  });

  it("rejects confidence outside 0-1 and missing fields", () => {
    expect(IssueRecommendationLLMOutputSchema.safeParse({ ...valid, confidence: 1.2 }).success).toBe(false);
    const { rationale: _drop, ...withoutRationale } = valid;
    expect(IssueRecommendationLLMOutputSchema.safeParse(withoutRationale).success).toBe(false);
  });

  it("allows a null automation idea", () => {
    expect(IssueRecommendationLLMOutputSchema.safeParse({ ...valid, automationIdea: null }).success).toBe(true);
  });
});

describe("automation idea invariant", () => {
  it("flags an idea attached to a not_applicable opportunity", () => {
    expect(
      violatesAutomationIdeaInvariant({ automationOpportunity: "not_applicable", automationIdea: "Something" }),
    ).toBe(true);
  });

  it("strips the idea when automation is not applicable", () => {
    const enforced = enforceAutomationIdeaInvariant({
      ...valid,
      automationOpportunity: "not_applicable",
      automationIdea: "Should be removed",
    });
    expect(enforced.automationIdea).toBeNull();
  });

  it("keeps an idea for low opportunity, which can still be actionable", () => {
    const enforced = enforceAutomationIdeaInvariant({ ...valid, automationOpportunity: "low" });
    expect(enforced.automationIdea).toBe("Nightly reconciliation of cancellation state.");
  });

  it("normalises a blank idea to null", () => {
    expect(enforceAutomationIdeaInvariant({ ...valid, automationIdea: "   " }).automationIdea).toBeNull();
  });

  it("leaves a valid recommendation untouched and does not mutate input", () => {
    const input = { ...valid };
    expect(enforceAutomationIdeaInvariant(input)).toEqual(valid);
    expect(input.automationIdea).toBe("Nightly reconciliation of cancellation state.");
  });
});

describe("scrubIdentifiers", () => {
  it("redacts email addresses", () => {
    const result = scrubIdentifiers("Contact jane.doe@example.com about it");
    expect(result.text).toContain("[EMAIL_REDACTED]");
    expect(result.text).not.toContain("jane.doe@example.com");
    expect(result.redactionCount).toBe(1);
  });

  it("redacts vendor-style object ids", () => {
    const result = scrubIdentifiers("Stripe customer cus_Nx9aBcDeFgHi failed");
    expect(result.text).toContain("[VENDOR_ID_REDACTED]");
    expect(result.redactionCount).toBe(1);
  });

  it("redacts UUIDs and long digit runs", () => {
    expect(scrubIdentifiers("id 550e8400-e29b-41d4-a716-446655440000").text).toContain("[UUID_REDACTED]");
    expect(scrubIdentifiers("phone 0412345678901").text).toContain("[LONG_NUMBER_REDACTED]");
  });

  it("leaves ordinary technical prose untouched", () => {
    const text = "Tax is omitted for partner and platform fee components on invoices";
    const result = scrubIdentifiers(text);
    expect(result.text).toBe(text);
    expect(result.redactionCount).toBe(0);
  });

  it("does not redact short numbers that carry meaning", () => {
    const result = scrubIdentifiers("3 occurrences over 40 days at 0.85 confidence");
    expect(result.redactionCount).toBe(0);
  });
});

describe("buildRecommendationPayload", () => {
  it("includes the aggregate evidence the recommendation needs", () => {
    const payload = buildRecommendationPayload(rankedIssue());

    expect(payload.name).toBe("Test issue");
    expect(payload.occurrenceCount).toBe(2);
    expect(payload.firstSeen).toBe("2026-06-01T00:00:00.000Z");
    expect(payload.spanDays).toBe(30);
    expect(payload.occurrences).toHaveLength(2);
  });

  it("carries root cause and resolution summary per occurrence", () => {
    const payload = buildRecommendationPayload(
      rankedIssue({
        members: [
          member({ suspectedRootCause: "State not propagated", resolutionSummary: "Manually corrected" }),
          member({ rootTs: "b" }),
        ],
      }),
    );
    expect(payload.occurrences[0]?.suspectedRootCause).toBe("State not propagated");
    expect(payload.occurrences[0]?.resolutionSummary).toBe("Manually corrected");
  });

  it("omits zero-count distribution buckets to keep the prompt tight", () => {
    const payload = buildRecommendationPayload(rankedIssue());
    expect(payload.severityDistribution.every((entry) => entry.count > 0)).toBe(true);
  });

  it("never includes permalinks, rootTs, or raw Slack fields", () => {
    const serialised = JSON.stringify(buildRecommendationPayload(rankedIssue()));
    expect(serialised).not.toContain("permalink");
    expect(serialised).not.toContain("rootTs");
    expect(serialised).not.toContain("slack");
    expect(serialised).not.toContain("ROOT MESSAGE");
  });

  it("scrubs identifiers that slipped through upstream and counts them", () => {
    const payload = buildRecommendationPayload(
      rankedIssue({
        members: [
          member({ suspectedRootCause: "Customer jane@example.com had cus_Nx9aBcDeFgHi stuck" }),
          member({ rootTs: "b" }),
        ],
      }),
    );

    expect(payload.redactionCount).toBe(2);
    expect(JSON.stringify(payload)).not.toContain("jane@example.com");
    expect(JSON.stringify(payload)).not.toContain("cus_Nx9aBcDeFgHi");
  });

  it("falls back to a placeholder when the group has no proposed name", () => {
    expect(buildRecommendationPayload(rankedIssue({ name: null })).name).toBe("(no proposed name)");
  });
});

describe("ISSUE_RECOMMENDATION prompt", () => {
  it("is version v1", () => {
    expect(ISSUE_RECOMMENDATION_PROMPT_VERSION).toBe("v1");
  });

  it("tells the model that recurrence is already settled upstream", () => {
    expect(ISSUE_RECOMMENDATION_SYSTEM_PROMPT).toContain("ALREADY been confirmed as recurring");
    expect(ISSUE_RECOMMENDATION_SYSTEM_PROMPT).toContain("not yours to revisit");
  });

  it("defines every action in the enum", () => {
    for (const action of RECOMMENDED_ACTIONS) {
      expect(ISSUE_RECOMMENDATION_SYSTEM_PROMPT).toContain(action);
    }
  });

  it("forbids recommending a fix when the mechanism is unknown", () => {
    expect(ISSUE_RECOMMENDATION_SYSTEM_PROMPT).toContain(
      "DO NOT recommend a permanent code fix when the evidence does not establish the technical mechanism",
    );
  });

  it("separates automation opportunity from priority", () => {
    expect(ISSUE_RECOMMENDATION_SYSTEM_PROMPT).toContain(
      "AUTOMATION OPPORTUNITY IS A SEPARATE JUDGEMENT FROM PRIORITY",
    );
  });

  it("constrains recommendation and evidence length", () => {
    expect(ISSUE_RECOMMENDATION_SYSTEM_PROMPT).toContain("at most 2 sentences");
  });

  it("builds a user prompt containing the evidence and no permalinks", () => {
    const prompt = buildIssueRecommendationUserPrompt(buildRecommendationPayload(rankedIssue()));
    expect(prompt).toContain("RECURRING ISSUE: Test issue");
    expect(prompt).toContain("occurrences: 2");
    expect(prompt).toContain("OCCURRENCE 1");
    expect(prompt).not.toContain("https://slack");
  });

  it("marks absent evidence rather than omitting the field", () => {
    const prompt = buildIssueRecommendationUserPrompt(
      buildRecommendationPayload(
        rankedIssue({ members: [member({ suspectedRootCause: null }), member({ rootTs: "b" })] }),
      ),
    );
    expect(prompt).toContain("suspected root cause: (not established)");
  });
});
