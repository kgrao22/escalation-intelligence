import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { describe, expect, it } from "vitest";
import {
  describeNormalization,
  ENUM_FIELD_RULES,
  normalizeEnumValues,
  readNormalizationDiagnostics,
  recordNormalizationDiagnostics,
} from "../src/llm/enumNormalization.js";
import {
  EscalationAnalysisLLMOutputSchema,
  type EscalationAnalysisLLMOutput,
} from "../src/llm/schemas/escalationAnalysis.js";
import { withEnumNormalization } from "../src/llm/structuredParse.js";

/** A response with every enum field valid. */
function validOutput(overrides: Partial<EscalationAnalysisLLMOutput> = {}): EscalationAnalysisLLMOutput {
  return {
    isTechnicalEscalation: true,
    classification: "technical_defect",
    normalizedProblemStatement: "Invoice fee components are calculated with the wrong tax rate.",
    affectedSystem: "billing-service",
    issueTypeHint: null,
    severity: "high",
    customerImpact: "single_customer",
    suspectedRootCause: null,
    rootCauseConfidence: null,
    resolutionStatus: "resolved",
    resolutionSummary: null,
    isRecurringEvidenceInThread: false,
    automationCandidate: "permanent_code_fix",
    automationReasoning: null,
    confidence: 0.9,
    isAutomationWorkflowCandidate: false,
    workflowClassification: null,
    normalizedWorkflowStatement: null,
    automationStatus: "unknown",
    ...overrides,
  };
}

describe("normalizeEnumValues — valid responses are untouched", () => {
  it("returns the very same object reference when everything is valid", () => {
    const input = validOutput();
    const outcome = normalizeEnumValues(input);
    expect(outcome.value).toBe(input);
    expect(outcome.diagnostics).toEqual([]);
  });

  it("leaves a valid null in a nullable field alone", () => {
    const input = validOutput({ severity: null, workflowClassification: null });
    const outcome = normalizeEnumValues(input);
    expect(outcome.value).toBe(input);
    expect(outcome.diagnostics).toEqual([]);
  });

  it("does not touch every legal value of every enum", () => {
    for (const rule of ENUM_FIELD_RULES) {
      for (const value of rule.allowed) {
        const input = validOutput({
          // A workflow classification is only legal alongside the flag.
          ...(rule.field === "workflowClassification" ? { isAutomationWorkflowCandidate: true } : {}),
          [rule.field]: value,
        } as Partial<EscalationAnalysisLLMOutput>);
        const outcome = normalizeEnumValues(input);
        expect(outcome.diagnostics, `${rule.field}=${value}`).toEqual([]);
      }
    }
  });
});

describe("normalizeEnumValues — invalid values", () => {
  it("maps an invented resolutionStatus to unclear", () => {
    const outcome = normalizeEnumValues(validOutput({ resolutionStatus: "partially_resolved" as never }));
    const record = outcome.value as EscalationAnalysisLLMOutput;
    expect(record.resolutionStatus).toBe("unclear");
    expect(outcome.diagnostics).toEqual([
      {
        field: "resolutionStatus",
        rawValue: "partially_resolved",
        fallbackValue: "unclear",
        reason: "value_not_in_enum",
        allowedValues: expect.arrayContaining(["resolved", "unclear"]),
      },
    ]);
  });

  it("maps an invented automationCandidate to unclear", () => {
    const outcome = normalizeEnumValues(validOutput({ automationCandidate: "build_a_dashboard" as never }));
    expect((outcome.value as EscalationAnalysisLLMOutput).automationCandidate).toBe("unclear");
    expect(outcome.diagnostics[0]?.reason).toBe("value_not_in_enum");
  });

  it("maps an invented classification to unclear", () => {
    const outcome = normalizeEnumValues(validOutput({ classification: "billing_problem" as never }));
    expect((outcome.value as EscalationAnalysisLLMOutput).classification).toBe("unclear");
  });

  it("maps an invalid customerImpact to unknown", () => {
    const outcome = normalizeEnumValues(validOutput({ customerImpact: "some" as never }));
    expect((outcome.value as EscalationAnalysisLLMOutput).customerImpact).toBe("unknown");
  });

  it("maps an invalid automationStatus to unknown", () => {
    const outcome = normalizeEnumValues(validOutput({ automationStatus: "scripted" as never }));
    expect((outcome.value as EscalationAnalysisLLMOutput).automationStatus).toBe("unknown");
  });

  it("maps an invalid severity to null rather than guessing a level", () => {
    const outcome = normalizeEnumValues(validOutput({ severity: "urgent" as never }));
    expect((outcome.value as EscalationAnalysisLLMOutput).severity).toBeNull();
    expect(outcome.diagnostics[0]?.fallbackValue).toBeNull();
  });

  it("never maps an invalid value onto a semantically specific category", () => {
    // Every fallback must be an explicit unknown/catch-all or null.
    const permitted = new Set([null, "unclear", "unknown", "other_operational_workflow"]);
    for (const rule of ENUM_FIELD_RULES) {
      for (const flag of [true, false]) {
        const fallback = rule.resolveFallback({ isAutomationWorkflowCandidate: flag });
        expect(permitted, `${rule.field} fallback`).toContain(fallback);
      }
    }
  });

  it("does not modify fields other than the invalid one", () => {
    const input = validOutput({ resolutionStatus: "nope" as never });
    const record = normalizeEnumValues(input).value as EscalationAnalysisLLMOutput;
    expect(record.classification).toBe("technical_defect");
    expect(record.normalizedProblemStatement).toBe(input.normalizedProblemStatement);
    expect(record.confidence).toBe(0.9);
    // The original object is not mutated.
    expect(input.resolutionStatus).toBe("nope");
  });
});

describe("normalizeEnumValues — workflowClassification is context-dependent", () => {
  it("falls back to other_operational_workflow when the thread IS a workflow", () => {
    const outcome = normalizeEnumValues(
      validOutput({ isAutomationWorkflowCandidate: true, workflowClassification: "cancel_policy" as never }),
    );
    expect((outcome.value as EscalationAnalysisLLMOutput).workflowClassification).toBe("other_operational_workflow");
  });

  it("falls back to null when the thread is NOT a workflow", () => {
    const outcome = normalizeEnumValues(
      validOutput({ isAutomationWorkflowCandidate: false, workflowClassification: "cancel_policy" as never }),
    );
    expect((outcome.value as EscalationAnalysisLLMOutput).workflowClassification).toBeNull();
  });
});

describe("normalizeEnumValues — null and missing values", () => {
  it("replaces null in a NON-nullable field and says why", () => {
    const outcome = normalizeEnumValues(validOutput({ resolutionStatus: null as never }));
    expect((outcome.value as EscalationAnalysisLLMOutput).resolutionStatus).toBe("unclear");
    expect(outcome.diagnostics[0]).toMatchObject({
      field: "resolutionStatus",
      rawValue: null,
      fallbackValue: "unclear",
      reason: "null_for_non_nullable_field",
    });
  });

  it("replaces a missing field and reports it as absent", () => {
    const partial = validOutput();
    delete (partial as Partial<EscalationAnalysisLLMOutput>).automationStatus;
    const outcome = normalizeEnumValues(partial);
    expect((outcome.value as EscalationAnalysisLLMOutput).automationStatus).toBe("unknown");
    expect(outcome.diagnostics[0]).toMatchObject({ reason: "missing_field", rawValue: undefined });
  });

  it("replaces a non-string value", () => {
    const outcome = normalizeEnumValues(validOutput({ customerImpact: 3 as never }));
    expect(outcome.diagnostics[0]).toMatchObject({ reason: "non_string_value", rawValue: 3 });
  });

  it("collects one diagnostic per offending field", () => {
    const outcome = normalizeEnumValues(
      validOutput({ resolutionStatus: "x" as never, automationCandidate: "y" as never, severity: "z" as never }),
    );
    expect(outcome.diagnostics.map((d) => d.field)).toEqual([
      "severity",
      "resolutionStatus",
      "automationCandidate",
    ]);
  });

  it("passes non-objects through for strict validation to reject", () => {
    expect(normalizeEnumValues(null).diagnostics).toEqual([]);
    expect(normalizeEnumValues("nope").diagnostics).toEqual([]);
    expect(normalizeEnumValues([1, 2]).diagnostics).toEqual([]);
  });
});

describe("withEnumNormalization", () => {
  const strict = zodOutputFormat(EscalationAnalysisLLMOutputSchema);
  const wrapped = withEnumNormalization(strict);

  it("keeps the wire schema identical so the model stays enum-constrained", () => {
    expect(wrapped.schema).toBe(strict.schema);
    expect(wrapped.type).toBe(strict.type);
  });

  it("still rejects a response the strict schema cannot accept", () => {
    // A missing non-enum required field is not normalization's business.
    const broken = validOutput();
    delete (broken as Partial<EscalationAnalysisLLMOutput>).confidence;
    expect(() => wrapped.parse(JSON.stringify(broken))).toThrow();
  });

  it("rescues the exact failure that broke the 180-day run", () => {
    const raw = JSON.stringify(validOutput({ resolutionStatus: "partially_resolved" as never }));
    expect(() => strict.parse(raw)).toThrow();

    const parsed = wrapped.parse(raw);
    expect(parsed.resolutionStatus).toBe("unclear");
    expect(readNormalizationDiagnostics(parsed)).toEqual([
      expect.objectContaining({ field: "resolutionStatus", rawValue: "partially_resolved" }),
    ]);
  });

  it("produces a valid parse with no diagnostics for a clean response", () => {
    const parsed = wrapped.parse(JSON.stringify(validOutput()));
    expect(parsed.resolutionStatus).toBe("resolved");
    expect(readNormalizationDiagnostics(parsed)).toEqual([]);
  });
});

describe("diagnostic carriage and formatting", () => {
  it("does not leak diagnostics between different parsed objects", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    recordNormalizationDiagnostics(a, [
      { field: "resolutionStatus", rawValue: "x", fallbackValue: "unclear", reason: "value_not_in_enum", allowedValues: [] },
    ]);
    expect(readNormalizationDiagnostics(a)).toHaveLength(1);
    expect(readNormalizationDiagnostics(b)).toEqual([]);
  });

  it("renders a one-line summary naming field, raw value, fallback, and reason", () => {
    const line = describeNormalization({
      field: "resolutionStatus",
      rawValue: "partially_resolved",
      fallbackValue: "unclear",
      reason: "value_not_in_enum",
      allowedValues: [],
    });
    expect(line).toBe('resolutionStatus: "partially_resolved" → "unclear" (value_not_in_enum)');
  });

  it("renders an absent field distinctly from a null one", () => {
    const absent = describeNormalization({
      field: "automationStatus",
      rawValue: undefined,
      fallbackValue: "unknown",
      reason: "missing_field",
      allowedValues: [],
    });
    expect(absent).toContain("(absent)");
  });
});
