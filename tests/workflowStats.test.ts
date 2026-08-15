import { describe, expect, it } from "vitest";
import { parseExtractArgs } from "../src/cli/extractArgs.js";
import { buildExtractionMetadata, failedRootTsValues, mergeRepairedResults } from "../src/llm/runExtraction.js";
import type { EscalationAnalysis } from "../src/llm/schemas/escalationAnalysis.js";
import type { ExtractionResultItem } from "../src/persistence/extractionOutput.js";
import {
  collectWorkflowSamples,
  computeWorkflowBreakdown,
  countWorkflowClassifications,
  describeFailedEnumFields,
} from "../src/workflow/workflowStats.js";

function analysis(rootTs: string, overrides: Partial<EscalationAnalysis>): EscalationAnalysis {
  return {
    rootTs,
    permalink: `https://slack.example/p${rootTs}`,
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

function ok(rootTs: string, overrides: Partial<EscalationAnalysis>): ExtractionResultItem {
  return { rootTs, status: "success", analysis: analysis(rootTs, overrides) };
}

/**
 * The six real-world validation cases. Each asserts the two independent
 * judgements and, where relevant, the workflow shape.
 */
const CASE_A_CANCEL = ok("1000000001.000100", {
  classification: "operational_request",
  isAutomationWorkflowCandidate: true,
  workflowClassification: "policy_cancellation",
  normalizedWorkflowStatement: "Cancel an existing policy by manually updating policy state in backend systems.",
  automationStatus: "manual",
});
const CASE_B_MOVE_TO_EDIT = ok("1000000002.000100", {
  classification: "operational_request",
  isAutomationWorkflowCandidate: true,
  workflowClassification: "policy_state_change",
  normalizedWorkflowStatement: "Move a policy or program back into an editable lifecycle state using manual backend controls.",
  automationStatus: "manual",
});
const CASE_C_REACTIVATE = ok("1000000003.000100", {
  classification: "operational_request",
  isAutomationWorkflowCandidate: true,
  workflowClassification: "policy_reactivation",
  normalizedWorkflowStatement: "Reactivate a policy that was cancelled in error so that coverage resumes for the customer.",
  automationStatus: "manual",
});
const CASE_D_EMAIL = ok("1000000004.000100", {
  classification: "customer_data_update",
  isAutomationWorkflowCandidate: true,
  workflowClassification: "customer_identity_update",
  normalizedWorkflowStatement: "Update a customer's email identity across dashboard and policy or account systems.",
  automationStatus: "partially_automated",
});
const CASE_E_ONE_OFF = ok("1000000005.000100", {
  classification: "question_or_support",
  isAutomationWorkflowCandidate: false,
});
const CASE_F_DEFECT_WITH_WORKAROUND = ok("1000000006.000100", {
  isTechnicalEscalation: true,
  classification: "technical_defect",
  normalizedProblemStatement: "Policy documents fail to generate for multi-location risks.",
  resolutionStatus: "workaround",
  isAutomationWorkflowCandidate: true,
  workflowClassification: "manual_document_operation",
  normalizedWorkflowStatement: "Manually regenerate and re-attach policy documents when automated document generation fails.",
  automationStatus: "manual",
});

const ALL_CASES = [
  CASE_A_CANCEL,
  CASE_B_MOVE_TO_EDIT,
  CASE_C_REACTIVATE,
  CASE_D_EMAIL,
  CASE_E_ONE_OFF,
  CASE_F_DEFECT_WITH_WORKAROUND,
];

describe("real-world validation cases", () => {
  it("A. cancel policy from backend → workflow, cancellation or state change", () => {
    expect(CASE_A_CANCEL.analysis?.isAutomationWorkflowCandidate).toBe(true);
    expect(["policy_cancellation", "policy_state_change"]).toContain(CASE_A_CANCEL.analysis?.workflowClassification);
  });

  it("B. move program back to edit → workflow, policy_state_change", () => {
    expect(CASE_B_MOVE_TO_EDIT.analysis?.isAutomationWorkflowCandidate).toBe(true);
    expect(CASE_B_MOVE_TO_EDIT.analysis?.workflowClassification).toBe("policy_state_change");
  });

  it("C. reactivate policy → workflow, reactivation or state change", () => {
    expect(CASE_C_REACTIVATE.analysis?.isAutomationWorkflowCandidate).toBe(true);
    expect(["policy_reactivation", "policy_state_change"]).toContain(CASE_C_REACTIVATE.analysis?.workflowClassification);
  });

  it("D. update customer email → workflow, customer_identity_update", () => {
    expect(CASE_D_EMAIL.analysis?.isAutomationWorkflowCandidate).toBe(true);
    expect(CASE_D_EMAIL.analysis?.workflowClassification).toBe("customer_identity_update");
  });

  it("E. one-off informational request → not a workflow", () => {
    expect(CASE_E_ONE_OFF.analysis?.isAutomationWorkflowCandidate).toBe(false);
    expect(CASE_E_ONE_OFF.analysis?.workflowClassification).toBeNull();
    expect(CASE_E_ONE_OFF.analysis?.normalizedWorkflowStatement).toBeNull();
  });

  it("F. defect with repeated manual workaround → technical AND workflow", () => {
    expect(CASE_F_DEFECT_WITH_WORKAROUND.analysis?.isTechnicalEscalation).toBe(true);
    expect(CASE_F_DEFECT_WITH_WORKAROUND.analysis?.isAutomationWorkflowCandidate).toBe(true);
  });
});

describe("computeWorkflowBreakdown", () => {
  it("produces a 2x2 that sums to the successful count", () => {
    const b = computeWorkflowBreakdown(ALL_CASES);
    expect(b.technicalAndWorkflow + b.workflowOnly + b.technicalOnly + b.neither).toBe(b.analysed);
    expect(b.analysed).toBe(6);
    expect(b.technicalAndWorkflow).toBe(1); // F
    expect(b.workflowOnly).toBe(4); // A-D
    expect(b.technicalOnly).toBe(0);
    expect(b.neither).toBe(1); // E
  });

  it("keeps the two dimensions consistent with each other", () => {
    const b = computeWorkflowBreakdown(ALL_CASES);
    expect(b.technical).toBe(b.technicalAndWorkflow + b.technicalOnly);
    expect(b.nonTechnical).toBe(b.workflowOnly + b.neither);
    expect(b.workflowCandidates).toBe(b.technicalAndWorkflow + b.workflowOnly);
    expect(b.nonWorkflow).toBe(b.technicalOnly + b.neither);
  });

  it("excludes failures from the buckets rather than counting them as 'neither'", () => {
    const withFailure = [...ALL_CASES, { rootTs: "9.9", status: "failed" as const, error: "boom" }];
    const b = computeWorkflowBreakdown(withFailure);
    expect(b.failed).toBe(1);
    expect(b.analysed).toBe(6);
    expect(b.neither).toBe(1); // still only case E
  });
});

describe("countWorkflowClassifications", () => {
  it("counts only workflow candidates and zeroes the rest", () => {
    const counts = countWorkflowClassifications(ALL_CASES);
    expect(counts.policy_cancellation).toBe(1);
    expect(counts.policy_state_change).toBe(1);
    expect(counts.policy_reactivation).toBe(1);
    expect(counts.customer_identity_update).toBe(1);
    expect(counts.manual_document_operation).toBe(1);
    expect(counts.account_data_update).toBe(0);
    expect(counts.other_operational_workflow).toBe(0);
  });
});

describe("collectWorkflowSamples", () => {
  it("returns only workflow candidates, tagged by nature, newest first", () => {
    const samples = collectWorkflowSamples(ALL_CASES, 20);
    expect(samples).toHaveLength(5);
    expect(samples[0]?.rootTs).toBe("1000000006.000100");
    expect(samples[0]?.nature).toBe("technical+workflow");
    expect(samples.at(-1)?.nature).toBe("workflow-only");
  });

  it("respects the limit", () => {
    expect(collectWorkflowSamples(ALL_CASES, 2)).toHaveLength(2);
  });

  it("carries a permalink for manual inspection", () => {
    expect(collectWorkflowSamples(ALL_CASES, 1)[0]?.permalink).toBeTruthy();
  });
});

describe("describeFailedEnumFields", () => {
  // Verbatim shape of the real 180-day failures.
  const realError = `Failed to parse structured output: Error: Failed to parse structured output: [
  {
    "code": "invalid_value",
    "values": [ "resolved", "workaround", "unresolved", "not_applicable", "unclear" ],
    "path": [ "resolutionStatus" ],
    "message": "Invalid option"
  }
]
Validation issues:
  - resolutionStatus: Invalid option: expected one of "resolved"`;

  it("names the offending field", () => {
    expect(describeFailedEnumFields(realError)).toEqual(["resolutionStatus"]);
  });

  it("returns an empty list for non-enum failures", () => {
    expect(describeFailedEnumFields("Connection reset by peer")).toEqual([]);
    expect(describeFailedEnumFields(undefined)).toEqual([]);
  });
});

describe("retry-failed plumbing", () => {
  const prior: ExtractionResultItem[] = [
    CASE_A_CANCEL,
    { rootTs: "bad-1", status: "failed", error: "enum" },
    CASE_B_MOVE_TO_EDIT,
    { rootTs: "bad-2", status: "failed", error: "enum" },
  ];

  it("identifies exactly the failed rootTs values", () => {
    expect(failedRootTsValues(prior)).toEqual(["bad-1", "bad-2"]);
  });

  it("replaces repaired records in place without duplicating or reordering", () => {
    const repaired = [ok("bad-1", { isAutomationWorkflowCandidate: false })];
    const merged = mergeRepairedResults(prior, repaired);

    expect(merged).toHaveLength(4);
    expect(merged.map((r) => r.rootTs)).toEqual(["1000000001.000100", "bad-1", "1000000002.000100", "bad-2"]);
    expect(merged[1]?.status).toBe("success");
    expect(merged[3]?.status).toBe("failed");
  });

  it("preserves prior successes untouched", () => {
    const merged = mergeRepairedResults(prior, [ok("bad-1", {})]);
    expect(merged[0]).toBe(CASE_A_CANCEL);
    expect(merged[2]).toBe(CASE_B_MOVE_TO_EDIT);
  });

  it("parses --retry-failed, defaulting to false", () => {
    expect(parseExtractArgs([]).retryFailed).toBe(false);
    expect(parseExtractArgs(["--retry-failed"]).retryFailed).toBe(true);
  });
});

describe("buildExtractionMetadata", () => {
  it("records both dimensions and the workflow type counts", () => {
    const metadata = buildExtractionMetadata({
      inputFile: "data/slack/escalations-180d-2026-08-12.json",
      analysedAt: new Date("2026-08-12T00:00:00.000Z"),
      promptVersion: "v3",
      promptRevision: "v3.1",
      model: "claude-haiku-4-5",
      threadsAvailable: 6,
      results: ALL_CASES,
    });

    expect(metadata.technicalEscalations).toBe(1);
    expect(metadata.nonTechnical).toBe(5);
    expect(metadata.workflowCandidates).toBe(5);
    expect(metadata.workflowOnly).toBe(4);
    expect(metadata.technicalAndWorkflow).toBe(1);
    expect(metadata.neither).toBe(1);
    expect(metadata.promptRevision).toBe("v3.1");
    expect(metadata.workflowClassificationCounts?.policy_reactivation).toBe(1);
  });
});
