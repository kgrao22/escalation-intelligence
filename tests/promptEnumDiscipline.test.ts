import { describe, expect, it } from "vitest";
import {
  ESCALATION_EXTRACTION_PROMPT_REVISION,
  ESCALATION_EXTRACTION_PROMPT_VERSION,
  ESCALATION_EXTRACTION_SYSTEM_PROMPT,
} from "../src/llm/prompts/escalationExtraction.js";
import {
  AutomationCandidateSchema,
  AutomationStatusSchema,
  ClassificationSchema,
  CustomerImpactSchema,
  ResolutionStatusSchema,
  SeveritySchema,
  WorkflowClassificationSchema,
} from "../src/llm/schemas/escalationAnalysis.js";

/**
 * The 180-day run lost four threads to enum values the model invented. The
 * prompt now lists every allowed value verbatim; these tests fail if a schema
 * ever gains a value the prompt does not teach, which is how that drift
 * reappears.
 */
const ENUMS = {
  classification: ClassificationSchema,
  severity: SeveritySchema,
  customerImpact: CustomerImpactSchema,
  resolutionStatus: ResolutionStatusSchema,
  automationCandidate: AutomationCandidateSchema,
  workflowClassification: WorkflowClassificationSchema,
  automationStatus: AutomationStatusSchema,
} as const;

describe("prompt enum discipline", () => {
  for (const [field, schema] of Object.entries(ENUMS)) {
    it(`teaches every allowed value of ${field}`, () => {
      for (const value of schema.options) {
        expect(ESCALATION_EXTRACTION_SYSTEM_PROMPT).toContain(value);
      }
    });
  }

  it("names each enum field so the model can bind values to fields", () => {
    for (const field of Object.keys(ENUMS)) {
      expect(ESCALATION_EXTRACTION_SYSTEM_PROMPT).toContain(field);
    }
  });

  it("states the hard constraint against inventing values", () => {
    const prompt = ESCALATION_EXTRACTION_SYSTEM_PROMPT.toLowerCase();
    expect(prompt).toContain("do not invent synonyms");
    expect(prompt).toContain("spelled exactly as shown");
    expect(prompt).toContain("fallback");
  });

  it("gives the three fields that actually failed an explicit fallback", () => {
    // resolutionStatus, automationCandidate → unclear; workflowClassification
    // → other_operational_workflow. These are the exact fields the 180-day run
    // lost threads on.
    expect(ESCALATION_EXTRACTION_SYSTEM_PROMPT).toContain("resolutionStatus (fallback: unclear)");
    expect(ESCALATION_EXTRACTION_SYSTEM_PROMPT).toContain("automationCandidate (fallback: unclear)");
    expect(ESCALATION_EXTRACTION_SYSTEM_PROMPT).toContain(
      "workflowClassification (nullable; fallback when isAutomationWorkflowCandidate is true: other_operational_workflow)",
    );
  });

  it("keeps the version at v3 so prior successes stay reusable, tracking the revision separately", () => {
    expect(ESCALATION_EXTRACTION_PROMPT_VERSION).toBe("v3");
    expect(ESCALATION_EXTRACTION_PROMPT_REVISION).toBe("v3.2");
  });
});
