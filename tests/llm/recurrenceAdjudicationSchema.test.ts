import { describe, expect, it } from "vitest";
import {
  enforceIssueNameInvariant,
  RecurrenceAdjudicationLLMOutputSchema,
  RELATIONSHIPS,
  violatesIssueNameInvariant,
  type RecurrenceAdjudicationLLMOutput,
} from "../../src/llm/schemas/recurrenceAdjudication.js";
import {
  buildRecurrenceAdjudicationUserPrompt,
  RECURRENCE_ADJUDICATION_PROMPT_VERSION,
  RECURRENCE_ADJUDICATION_SYSTEM_PROMPT,
} from "../../src/llm/prompts/recurrenceAdjudication.js";

const sameVerdict: RecurrenceAdjudicationLLMOutput = {
  relationship: "same_underlying_issue",
  confidence: 0.9,
  reasoning: "Both are the same GST calculation defect.",
  proposedRecurringIssueName: "Incorrect GST calculation on invoice fee components",
};

describe("RecurrenceAdjudicationLLMOutputSchema", () => {
  it("exposes exactly the three relationship values", () => {
    expect(RELATIONSHIPS).toEqual(["same_underlying_issue", "related_problem_family", "different"]);
  });

  it("accepts each valid relationship", () => {
    for (const relationship of RELATIONSHIPS) {
      const result = RecurrenceAdjudicationLLMOutputSchema.safeParse({
        ...sameVerdict,
        relationship,
        proposedRecurringIssueName: relationship === "same_underlying_issue" ? "A name" : null,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an unknown relationship", () => {
    expect(
      RecurrenceAdjudicationLLMOutputSchema.safeParse({ ...sameVerdict, relationship: "maybe_same" }).success,
    ).toBe(false);
  });

  it("rejects confidence outside 0-1", () => {
    expect(RecurrenceAdjudicationLLMOutputSchema.safeParse({ ...sameVerdict, confidence: 1.4 }).success).toBe(false);
    expect(RecurrenceAdjudicationLLMOutputSchema.safeParse({ ...sameVerdict, confidence: -0.1 }).success).toBe(false);
  });

  it("rejects a missing required field", () => {
    const { reasoning: _drop, ...withoutReasoning } = sameVerdict;
    expect(RecurrenceAdjudicationLLMOutputSchema.safeParse(withoutReasoning).success).toBe(false);
  });

  it("allows a null issue name", () => {
    expect(
      RecurrenceAdjudicationLLMOutputSchema.safeParse({ ...sameVerdict, proposedRecurringIssueName: null }).success,
    ).toBe(true);
  });
});

describe("issue-name invariant", () => {
  it("flags a RELATED verdict carrying an issue name", () => {
    expect(
      violatesIssueNameInvariant({
        relationship: "related_problem_family",
        proposedRecurringIssueName: "Payment link failures",
      }),
    ).toBe(true);
  });

  it("flags a DIFFERENT verdict carrying an issue name", () => {
    expect(
      violatesIssueNameInvariant({ relationship: "different", proposedRecurringIssueName: "Anything" }),
    ).toBe(true);
  });

  it("does not flag a SAME verdict carrying an issue name", () => {
    expect(violatesIssueNameInvariant(sameVerdict)).toBe(false);
  });

  it("nulls the issue name on RELATED and DIFFERENT verdicts", () => {
    for (const relationship of ["related_problem_family", "different"] as const) {
      const enforced = enforceIssueNameInvariant({
        ...sameVerdict,
        relationship,
        proposedRecurringIssueName: "Should be removed",
      });
      expect(enforced.proposedRecurringIssueName).toBeNull();
      expect(enforced.relationship).toBe(relationship);
    }
  });

  it("leaves a valid SAME verdict untouched", () => {
    expect(enforceIssueNameInvariant(sameVerdict)).toEqual(sameVerdict);
  });

  it("normalises a blank SAME issue name to null", () => {
    expect(
      enforceIssueNameInvariant({ ...sameVerdict, proposedRecurringIssueName: "   " }).proposedRecurringIssueName,
    ).toBeNull();
  });

  it("preserves reasoning and confidence when stripping a name", () => {
    const enforced = enforceIssueNameInvariant({
      ...sameVerdict,
      relationship: "different",
      confidence: 0.42,
      reasoning: "Kept",
    });
    expect(enforced.confidence).toBe(0.42);
    expect(enforced.reasoning).toBe("Kept");
  });

  it("does not mutate its input", () => {
    const input = { ...sameVerdict, relationship: "different" as const };
    enforceIssueNameInvariant(input);
    expect(input.proposedRecurringIssueName).toBe("Incorrect GST calculation on invoice fee components");
  });
});

describe("RECURRENCE_ADJUDICATION_SYSTEM_PROMPT", () => {
  it("is version v1", () => {
    expect(RECURRENCE_ADJUDICATION_PROMPT_VERSION).toBe("v1");
  });

  it("defines all three relationships", () => {
    for (const relationship of RELATIONSHIPS) {
      expect(RECURRENCE_ADJUDICATION_SYSTEM_PROMPT).toContain(relationship);
    }
  });

  it("instructs conservatism and lists the shared-domain traps", () => {
    expect(RECURRENCE_ADJUDICATION_SYSTEM_PROMPT).toContain("BE CONSERVATIVE");
    for (const trap of ["payments", "renewals", "dashboards", "endorsements", "quote generation"]) {
      expect(RECURRENCE_ADJUDICATION_SYSTEM_PROMPT).toContain(trap);
    }
  });

  it("states the tie-break rules", () => {
    expect(RECURRENCE_ADJUDICATION_SYSTEM_PROMPT).toContain("choose related_problem_family");
    expect(RECURRENCE_ADJUDICATION_SYSTEM_PROMPT).toContain("lower your confidence");
  });

  it("makes root-cause evidence decisive", () => {
    expect(RECURRENCE_ADJUDICATION_SYSTEM_PROMPT).toContain("ROOT CAUSE EVIDENCE IS DECISIVE");
    expect(RECURRENCE_ADJUDICATION_SYSTEM_PROMPT).toContain("materially different root causes");
  });

  it("restricts the issue name to SAME verdicts", () => {
    expect(RECURRENCE_ADJUDICATION_SYSTEM_PROMPT).toContain("ONLY when relationship is same_underlying_issue");
  });
});

describe("buildRecurrenceAdjudicationUserPrompt", () => {
  it("labels both escalations and includes every evidence field", () => {
    const prompt = buildRecurrenceAdjudicationUserPrompt(
      {
        normalizedProblemStatement: "Statement A",
        classification: "technical_defect",
        affectedSystem: "billing",
        issueTypeHint: "calculation",
        suspectedRootCause: "Cause A",
        rootCauseConfidence: 0.7,
        resolutionStatus: "resolved",
        resolutionSummary: "Fixed A",
      },
      { normalizedProblemStatement: "Statement B" },
    );

    expect(prompt).toContain("ESCALATION A");
    expect(prompt).toContain("ESCALATION B");
    expect(prompt).toContain("Cause A");
    expect(prompt).toContain("root cause confidence: 0.7");
    expect(prompt).toContain("Fixed A");
  });

  it("reports absent fields as not established", () => {
    const prompt = buildRecurrenceAdjudicationUserPrompt(
      { normalizedProblemStatement: "A", suspectedRootCause: null },
      { normalizedProblemStatement: "B" },
    );
    expect(prompt).toContain("suspected root cause: (not established)");
  });

  it("treats an empty string as not established rather than printing nothing", () => {
    const prompt = buildRecurrenceAdjudicationUserPrompt(
      { normalizedProblemStatement: "A", affectedSystem: "" },
      { normalizedProblemStatement: "B" },
    );
    expect(prompt).toContain("affected system: (not established)");
  });
});
