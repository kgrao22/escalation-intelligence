import { describe, expect, it } from "vitest";
import {
  EscalationAnalysisLLMOutputSchema,
  enforceNonTechnicalInvariant,
  violatesNonTechnicalInvariant,
  type EscalationAnalysisLLMOutput,
} from "../../src/llm/schemas/escalationAnalysis.js";
import {
  ESCALATION_EXTRACTION_PROMPT_VERSION,
  ESCALATION_EXTRACTION_SYSTEM_PROMPT,
} from "../../src/llm/prompts/escalationExtraction.js";

const validOutput: EscalationAnalysisLLMOutput = {
  isTechnicalEscalation: true,
  classification: "technical_defect",
  normalizedProblemStatement: "Bulk file uploads time out for files over 50MB",
  affectedSystem: "fleet-upload-service",
  issueTypeHint: "timeout",
  severity: "high",
  customerImpact: "multiple_customers",
  suspectedRootCause: null,
  rootCauseConfidence: null,
  resolutionStatus: "unresolved",
  resolutionSummary: null,
  isRecurringEvidenceInThread: false,
  automationCandidate: "permanent_code_fix",
  automationReasoning: "Clear technical fix, no case-specific judgment required",
    isAutomationWorkflowCandidate: false,
    workflowClassification: null,
    normalizedWorkflowStatement: null,
    automationStatus: "unknown",
  confidence: 0.8,
};

describe("EscalationAnalysisLLMOutputSchema", () => {
  it("accepts a fully valid structured response", () => {
    const result = EscalationAnalysisLLMOutputSchema.safeParse(validOutput);
    expect(result.success).toBe(true);
  });

  it("accepts null for nullable fields", () => {
    const result = EscalationAnalysisLLMOutputSchema.safeParse({
      ...validOutput,
      normalizedProblemStatement: null,
      affectedSystem: null,
      issueTypeHint: null,
      severity: null,
      resolutionSummary: null,
      automationReasoning: null,
    isAutomationWorkflowCandidate: false,
    workflowClassification: null,
    normalizedWorkflowStatement: null,
    automationStatus: "unknown",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid classification enum value", () => {
    const result = EscalationAnalysisLLMOutputSchema.safeParse({ ...validOutput, classification: "totally_made_up" });
    expect(result.success).toBe(false);
  });

  it("rejects a confidence value outside 0-1", () => {
    const result = EscalationAnalysisLLMOutputSchema.safeParse({ ...validOutput, confidence: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects a missing required field", () => {
    const { isTechnicalEscalation: _drop, ...withoutRequired } = validOutput;
    const result = EscalationAnalysisLLMOutputSchema.safeParse(withoutRequired);
    expect(result.success).toBe(false);
  });

  it("rejects customerImpact values outside the enum", () => {
    const result = EscalationAnalysisLLMOutputSchema.safeParse({ ...validOutput, customerImpact: "a_few_customers" });
    expect(result.success).toBe(false);
  });
});

describe("non-technical invariant: normalizedProblemStatement must be null", () => {
  const nonTechnicalWithStatement = {
    ...validOutput,
    isTechnicalEscalation: false,
    classification: "access_request" as const,
    normalizedProblemStatement: "User cannot access the admin dashboard",
    affectedSystem: "admin-dashboard",
    issueTypeHint: "permissions",
  };

  it("detects a violation when a non-technical item carries a problem statement", () => {
    expect(violatesNonTechnicalInvariant(nonTechnicalWithStatement)).toBe(true);
  });

  it("nulls out normalizedProblemStatement for non-technical items", () => {
    const enforced = enforceNonTechnicalInvariant(nonTechnicalWithStatement);
    expect(enforced.normalizedProblemStatement).toBeNull();
    expect(violatesNonTechnicalInvariant(enforced)).toBe(false);
  });

  it("preserves affectedSystem and issueTypeHint on non-technical items", () => {
    const enforced = enforceNonTechnicalInvariant(nonTechnicalWithStatement);
    expect(enforced.affectedSystem).toBe("admin-dashboard");
    expect(enforced.issueTypeHint).toBe("permissions");
  });

  it("leaves technical escalations completely untouched", () => {
    const enforced = enforceNonTechnicalInvariant(validOutput);
    expect(enforced).toEqual(validOutput);
    expect(enforced.normalizedProblemStatement).toBe(validOutput.normalizedProblemStatement);
  });

  it("is a no-op for a non-technical item that already has a null statement", () => {
    const alreadyNull = { ...validOutput, isTechnicalEscalation: false, normalizedProblemStatement: null };
    expect(violatesNonTechnicalInvariant(alreadyNull)).toBe(false);
    expect(enforceNonTechnicalInvariant(alreadyNull)).toEqual(alreadyNull);
  });

  it("does not mutate the input object", () => {
    const input = { ...nonTechnicalWithStatement };
    enforceNonTechnicalInvariant(input);
    expect(input.normalizedProblemStatement).toBe("User cannot access the admin dashboard");
  });
});

describe("ESCALATION_EXTRACTION_SYSTEM_PROMPT de-identification expectations", () => {
  it("instructs the model to keep identifiers out of its output", () => {
    expect(ESCALATION_EXTRACTION_SYSTEM_PROMPT).toMatch(/de-identification/i);
    expect(ESCALATION_EXTRACTION_SYSTEM_PROMPT.toLowerCase()).toContain("customer");
  });

  it("gives a concrete bad/good de-identification example matching the spec", () => {
    expect(ESCALATION_EXTRACTION_SYSTEM_PROMPT).toContain("BAD:");
    expect(ESCALATION_EXTRACTION_SYSTEM_PROMPT).toContain("GOOD:");
  });

  it("instructs the model not to invent root causes", () => {
    expect(ESCALATION_EXTRACTION_SYSTEM_PROMPT.toLowerCase()).toContain("do not invent root causes");
  });
});

describe("ESCALATION_EXTRACTION_SYSTEM_PROMPT v3 cluster-friendliness guidance", () => {
  const prompt = ESCALATION_EXTRACTION_SYSTEM_PROMPT.toLowerCase();

  it("is version v3", () => {
    expect(ESCALATION_EXTRACTION_PROMPT_VERSION).toBe("v3");
  });

  it("instructs that non-technical items get a null problem statement", () => {
    expect(prompt).toContain("istechnicalescalation is false");
    expect(prompt).toContain("must be null");
  });

  it("asks for one concise sentence in the 15-30 word range", () => {
    expect(prompt).toContain("one concise sentence");
    expect(prompt).toContain("15-30 words");
  });

  it("excludes remediation and root-cause explanation from the problem statement", () => {
    expect(prompt).toContain("no remediation");
    expect(prompt).toContain("no root-cause explanation");
  });

  it("directs detail to the other fields instead", () => {
    expect(prompt).toContain("suspectedrootcause");
    expect(prompt).toContain("resolutionsummary");
    expect(prompt).toContain("automationreasoning");
    expect(prompt).toContain("do not overload normalizedproblemstatement");
  });
});
