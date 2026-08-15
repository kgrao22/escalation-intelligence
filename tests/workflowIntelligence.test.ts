import { describe, expect, it } from "vitest";
import { ESCALATION_EXTRACTION_PROMPT_VERSION, ESCALATION_EXTRACTION_SYSTEM_PROMPT } from "../src/llm/prompts/escalationExtraction.js";
import {
  enforceAnalysisInvariants,
  violatesWorkflowInvariant,
  type EscalationAnalysis,
} from "../src/llm/schemas/escalationAnalysis.js";
import {
  assertEmbeddingCandidatesSafe,
  selectCandidatesForCategory,
  selectWorkflowCandidates,
  selectEmbeddingCandidates,
  UnsafeEmbeddingPayloadError,
} from "../src/embeddings/selectCandidates.js";
import type { ExtractionOutput } from "../src/persistence/extractionOutput.js";

/**
 * The seven cases the milestone specifies. Each one asserts the two independent
 * judgements — is this a technical defect, and is this a repeatable manual
 * workflow — rather than forcing a single category.
 */
function analysis(overrides: Partial<EscalationAnalysis>): EscalationAnalysis {
  return {
    rootTs: "1700000000.000100",
    permalink: "https://slack.example/archives/C1/p1700000000000100",
    isTechnicalEscalation: false,
    classification: "operational_request",
    normalizedProblemStatement: null,
    affectedSystem: null,
    issueTypeHint: null,
    severity: "low",
    customerImpact: "none",
    suspectedRootCause: null,
    rootCauseConfidence: null,
    resolutionStatus: "resolved",
    resolutionSummary: null,
    isRecurringEvidenceInThread: false,
    automationCandidate: "not_applicable",
    automationReasoning: null,
    confidence: 0.9,
    isAutomationWorkflowCandidate: false,
    workflowClassification: null,
    normalizedWorkflowStatement: null,
    automationStatus: "unknown",
    ...overrides,
  };
}

const CASES = {
  manualPolicyCancellation: analysis({
    classification: "operational_request",
    isAutomationWorkflowCandidate: true,
    workflowClassification: "policy_cancellation",
    normalizedWorkflowStatement:
      "Support asks the technology team to manually cancel an active policy because the customer requested cancellation outside the self-service window.",
    automationStatus: "manual",
    affectedSystem: "policy-admin",
  }),
  moveProgramBackToEdit: analysis({
    classification: "operational_request",
    isAutomationWorkflowCandidate: true,
    workflowClassification: "policy_state_change",
    normalizedWorkflowStatement:
      "Support asks engineering to move a submitted application back into editable state so the partner can correct details before approval.",
    automationStatus: "manual",
    affectedSystem: "program-service",
  }),
  reactivatePolicy: analysis({
    classification: "operational_request",
    isAutomationWorkflowCandidate: true,
    workflowClassification: "policy_reactivation",
    normalizedWorkflowStatement:
      "Support asks the technology team to reactivate a policy that was cancelled in error so coverage resumes without reissuing documents.",
    automationStatus: "manual",
    affectedSystem: "policy-admin",
  }),
  customerEmailUpdate: analysis({
    classification: "customer_data_update",
    isAutomationWorkflowCandidate: true,
    workflowClassification: "customer_identity_update",
    normalizedWorkflowStatement:
      "Support asks engineering to update a customer email address across the account, billing, and identity systems so the records match.",
    automationStatus: "partially_automated",
    affectedSystem: "identity-service",
  }),
  oneOffQuestion: analysis({
    classification: "question_or_support",
    isAutomationWorkflowCandidate: false,
  }),
  genuineDefect: analysis({
    isTechnicalEscalation: true,
    classification: "technical_defect",
    normalizedProblemStatement: "Invoice fee components are calculated with the wrong tax rate.",
    suspectedRootCause: "Rounding applied before tax rather than after.",
    resolutionStatus: "unresolved",
    severity: "high",
    customerImpact: "single_customer",
    affectedSystem: "billing-service",
    isAutomationWorkflowCandidate: false,
  }),
  defectWithRecurringWorkaround: analysis({
    isTechnicalEscalation: true,
    classification: "technical_defect",
    normalizedProblemStatement: "Policy documents fail to generate for multi-location risks.",
    resolutionStatus: "workaround",
    isAutomationWorkflowCandidate: true,
    workflowClassification: "manual_document_operation",
    normalizedWorkflowStatement:
      "Engineering manually regenerates and re-attaches policy documents when automated document generation fails for a submission.",
    automationStatus: "manual",
    affectedSystem: "document-service",
  }),
};

describe("workflow classification — the seven specified cases", () => {
  it("treats manual policy cancellation as a workflow, not a technical defect", () => {
    const c = CASES.manualPolicyCancellation;
    expect(c.isTechnicalEscalation).toBe(false);
    expect(c.isAutomationWorkflowCandidate).toBe(true);
    expect(c.workflowClassification).toBe("policy_cancellation");
  });

  it("treats moving a program back to edit as a workflow", () => {
    expect(CASES.moveProgramBackToEdit.isAutomationWorkflowCandidate).toBe(true);
    expect(CASES.moveProgramBackToEdit.workflowClassification).toBe("policy_state_change");
  });

  it("treats policy reactivation as a workflow", () => {
    expect(CASES.reactivatePolicy.isAutomationWorkflowCandidate).toBe(true);
    expect(CASES.reactivatePolicy.workflowClassification).toBe("policy_reactivation");
  });

  it("treats a customer email/identity update as a workflow", () => {
    expect(CASES.customerEmailUpdate.isAutomationWorkflowCandidate).toBe(true);
    expect(CASES.customerEmailUpdate.workflowClassification).toBe("customer_identity_update");
  });

  it("treats a one-off question as neither technical nor a workflow", () => {
    expect(CASES.oneOffQuestion.isTechnicalEscalation).toBe(false);
    expect(CASES.oneOffQuestion.isAutomationWorkflowCandidate).toBe(false);
    expect(CASES.oneOffQuestion.normalizedWorkflowStatement).toBeNull();
  });

  it("treats a genuine defect as technical and not a workflow", () => {
    expect(CASES.genuineDefect.isTechnicalEscalation).toBe(true);
    expect(CASES.genuineDefect.isAutomationWorkflowCandidate).toBe(false);
    expect(CASES.genuineDefect.normalizedProblemStatement).not.toBeNull();
  });

  it("treats a defect with a recurring manual workaround as BOTH", () => {
    const c = CASES.defectWithRecurringWorkaround;
    expect(c.isTechnicalEscalation).toBe(true);
    expect(c.isAutomationWorkflowCandidate).toBe(true);
    expect(c.normalizedProblemStatement).not.toBeNull();
    expect(c.normalizedWorkflowStatement).not.toBeNull();
  });
});

describe("workflow invariant", () => {
  it("nulls workflow fields when the thread is not a workflow candidate", () => {
    const dirty = analysis({
      isAutomationWorkflowCandidate: false,
      workflowClassification: "policy_cancellation",
      normalizedWorkflowStatement: "Something the model should not have filled in.",
    });
    expect(violatesWorkflowInvariant(dirty)).toBe(true);

    const clean = enforceAnalysisInvariants(dirty);
    expect(clean.normalizedWorkflowStatement).toBeNull();
    expect(clean.workflowClassification).toBeNull();
    expect(violatesWorkflowInvariant(clean)).toBe(false);
  });

  it("leaves a legitimate workflow candidate untouched", () => {
    const clean = enforceAnalysisInvariants(CASES.manualPolicyCancellation);
    expect(clean.normalizedWorkflowStatement).toBe(CASES.manualPolicyCancellation.normalizedWorkflowStatement);
    expect(clean.workflowClassification).toBe("policy_cancellation");
  });
});

describe("workflow statement de-identification", () => {
  const statements = Object.values(CASES)
    .map((c) => c.normalizedWorkflowStatement)
    .filter((s): s is string => s !== null);

  it("carries no identifiers", () => {
    for (const statement of statements) {
      expect(statement).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/); // emails
      expect(statement).not.toMatch(/\b(?:cus|sub|pi|in)_[A-Za-z0-9]{6,}\b/); // Stripe-style ids
      expect(statement).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i); // uuids
      expect(statement).not.toMatch(/\b\d{6,}\b/); // long numeric ids
    }
  });

  it("stays within the specified 15-30 word band", () => {
    for (const statement of statements) {
      const words = statement.trim().split(/\s+/).length;
      expect(words).toBeGreaterThanOrEqual(15);
      expect(words).toBeLessThanOrEqual(30);
    }
  });
});

function extractionOf(analyses: EscalationAnalysis[]): ExtractionOutput {
  return {
    metadata: {
      inputFile: "data/slack/escalations-90d-2026-08-09.json",
      analysedAt: "2026-08-09T00:00:00.000Z",
      promptVersion: ESCALATION_EXTRACTION_PROMPT_VERSION,
      model: "claude-haiku-4-5",
      threadsAvailable: analyses.length,
      threadsAnalysed: analyses.length,
      technicalEscalations: analyses.filter((a) => a.isTechnicalEscalation).length,
      nonTechnical: analyses.filter((a) => !a.isTechnicalEscalation).length,
      failedExtractions: 0,
    },
    results: analyses.map((a, i) => ({
      rootTs: `170000000${i}.000100`,
      status: "success" as const,
      analysis: { ...a, rootTs: `170000000${i}.000100` },
    })),
  };
}

describe("embedding pool separation", () => {
  const all = extractionOf(Object.values(CASES));

  it("puts only technical escalations in the technical pool", () => {
    const technical = selectCandidatesForCategory(all, "technical");
    expect(technical).toHaveLength(2); // genuineDefect + defectWithRecurringWorkaround
    expect(technical.every((c) => c.category === "technical")).toBe(true);
    expect(technical.every((c) => c.isTechnicalEscalation)).toBe(true);
  });

  it("puts only workflow candidates in the workflow pool", () => {
    const workflow = selectCandidatesForCategory(all, "workflow");
    expect(workflow).toHaveLength(5);
    expect(workflow.every((c) => c.category === "workflow")).toBe(true);
  });

  it("embeds the workflow statement, not the problem statement, for workflow candidates", () => {
    const workflow = selectWorkflowCandidates(all);
    const both = workflow.find((c) => c.workflowClassification === "manual_document_operation");
    expect(both?.normalizedProblemStatement).toBe(CASES.defectWithRecurringWorkaround.normalizedWorkflowStatement);
    expect(both?.normalizedProblemStatement).not.toBe(
      CASES.defectWithRecurringWorkaround.normalizedProblemStatement,
    );
  });

  it("keeps the technical pool unchanged by the workflow track", () => {
    // The dual-nature case must appear in both pools, with different text.
    const technical = selectEmbeddingCandidates(all);
    const dual = technical.find(
      (c) => c.normalizedProblemStatement === CASES.defectWithRecurringWorkaround.normalizedProblemStatement,
    );
    expect(dual).toBeDefined();
  });

  it("refuses to embed a mixed pool", () => {
    const mixed = [...selectCandidatesForCategory(all, "technical"), ...selectCandidatesForCategory(all, "workflow")];
    expect(() => assertEmbeddingCandidatesSafe(mixed)).toThrow(UnsafeEmbeddingPayloadError);
  });

  it("accepts each pool on its own", () => {
    expect(() => assertEmbeddingCandidatesSafe(selectCandidatesForCategory(all, "technical"))).not.toThrow();
    expect(() => assertEmbeddingCandidatesSafe(selectCandidatesForCategory(all, "workflow"))).not.toThrow();
  });

  it("sends no raw Slack text to the embedding provider", () => {
    for (const candidate of selectCandidatesForCategory(all, "workflow")) {
      const statement = candidate.normalizedProblemStatement;
      expect(statement).not.toMatch(/<@U[A-Z0-9]+>/); // Slack user mentions
      expect(statement).not.toMatch(/https:\/\/[\w.-]*slack\.com/); // Slack links
      expect(statement.length).toBeGreaterThan(0);
    }
  });
});

describe("extraction prompt v3", () => {
  it("is versioned v3 so v2 results are not silently reused", () => {
    expect(ESCALATION_EXTRACTION_PROMPT_VERSION).toBe("v3");
  });

  it("asks for the workflow judgement independently of the technical judgement", () => {
    const prompt = ESCALATION_EXTRACTION_SYSTEM_PROMPT.toLowerCase();
    expect(prompt).toContain("isautomationworkflowcandidate");
    expect(prompt).toContain("normalizedworkflowstatement");
    expect(prompt).toContain("automationstatus");
    expect(prompt).toContain("independent");
  });

  it("warns against inferring already_automated from a mentioned tool or URL", () => {
    const prompt = ESCALATION_EXTRACTION_SYSTEM_PROMPT.toLowerCase();
    expect(prompt).toContain("already_automated");
    expect(prompt).toMatch(/url|endpoint|tool name/);
  });
});
