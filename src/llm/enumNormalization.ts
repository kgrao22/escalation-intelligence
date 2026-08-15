import {
  AutomationCandidateSchema,
  AutomationStatusSchema,
  ClassificationSchema,
  CustomerImpactSchema,
  ResolutionStatusSchema,
  SeveritySchema,
  WorkflowClassificationSchema,
} from "./schemas/escalationAnalysis.js";

/**
 * Why a field was rewritten. Kept as a closed vocabulary so diagnostics can be
 * aggregated across runs rather than grepped as prose.
 */
export type NormalizationReason =
  | "value_not_in_enum"
  | "null_for_non_nullable_field"
  | "missing_field"
  | "non_string_value";

export interface EnumNormalizationDiagnostic {
  field: string;
  /** Exactly what the model returned, before any rewriting. */
  rawValue: unknown;
  fallbackValue: string | null;
  reason: NormalizationReason;
  /** The values that would have been accepted, for post-hoc analysis. */
  allowedValues: readonly string[];
}

type FallbackResolver = (record: Record<string, unknown>) => string | null;

interface EnumFieldRule {
  field: string;
  allowed: readonly string[];
  /** When true, an explicit null is a VALID value and is never rewritten. */
  nullable: boolean;
  resolveFallback: FallbackResolver;
  /** Human-readable rule, surfaced in docs and asserted in tests. */
  describe: string;
}

const constant =
  (value: string | null): FallbackResolver =>
  () =>
    value;

/**
 * The fallbacks below are exactly those documented in the v3.1 extraction
 * prompt. Every one of them lands on a designated "I don't know" bucket —
 * `unclear`, `unknown`, `other_operational_workflow`, or `null`. None of them
 * guesses a semantically specific category, because a wrong-but-specific value
 * silently corrupts recurrence counts, whereas an explicit unknown does not.
 */
export const ENUM_FIELD_RULES: readonly EnumFieldRule[] = [
  {
    field: "classification",
    allowed: ClassificationSchema.options,
    nullable: false,
    resolveFallback: constant("unclear"),
    describe: "classification → unclear",
  },
  {
    field: "severity",
    allowed: SeveritySchema.options,
    nullable: true,
    resolveFallback: constant(null),
    describe: "severity → null (the schema's own nullable, not a severity guess)",
  },
  {
    field: "customerImpact",
    allowed: CustomerImpactSchema.options,
    nullable: false,
    resolveFallback: constant("unknown"),
    describe: "customerImpact → unknown",
  },
  {
    field: "resolutionStatus",
    allowed: ResolutionStatusSchema.options,
    nullable: false,
    resolveFallback: constant("unclear"),
    describe: "resolutionStatus → unclear",
  },
  {
    field: "automationCandidate",
    allowed: AutomationCandidateSchema.options,
    nullable: false,
    resolveFallback: constant("unclear"),
    describe: "automationCandidate → unclear",
  },
  {
    field: "workflowClassification",
    allowed: WorkflowClassificationSchema.options,
    nullable: true,
    // The only context-dependent rule: a workflow candidate must still name a
    // shape, so it falls back to the catch-all rather than to null, which
    // would contradict isAutomationWorkflowCandidate === true.
    resolveFallback: (record) =>
      record.isAutomationWorkflowCandidate === true ? "other_operational_workflow" : null,
    describe:
      "workflowClassification → null when isAutomationWorkflowCandidate is false, otherwise other_operational_workflow",
  },
  {
    field: "automationStatus",
    allowed: AutomationStatusSchema.options,
    nullable: false,
    resolveFallback: constant("unknown"),
    describe: "automationStatus → unknown",
  },
];

export interface NormalizationOutcome {
  value: unknown;
  diagnostics: EnumNormalizationDiagnostic[];
}

function classify(
  rule: EnumFieldRule,
  present: boolean,
  raw: unknown,
): NormalizationReason | null {
  if (!present) {
    return "missing_field";
  }
  if (raw === null || raw === undefined) {
    // A nullable field is entitled to be null; a non-nullable one is not.
    return rule.nullable ? null : "null_for_non_nullable_field";
  }
  if (typeof raw !== "string") {
    return "non_string_value";
  }
  return rule.allowed.includes(raw) ? null : "value_not_in_enum";
}

/**
 * Rewrites ONLY enum fields that strict validation would otherwise reject, and
 * only onto documented fallbacks. A response whose enum fields are all valid is
 * returned byte-identical — same object reference, no diagnostics — so the
 * overwhelmingly common good path is provably untouched.
 */
export function normalizeEnumValues(
  raw: unknown,
  rules: readonly EnumFieldRule[] = ENUM_FIELD_RULES,
): NormalizationOutcome {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    // Not an object: nothing to normalize. Let strict validation report it.
    return { value: raw, diagnostics: [] };
  }

  const record = raw as Record<string, unknown>;
  const diagnostics: EnumNormalizationDiagnostic[] = [];
  let patched: Record<string, unknown> | null = null;

  for (const rule of rules) {
    const present = Object.hasOwn(record, rule.field);
    const rawValue = record[rule.field];
    const reason = classify(rule, present, rawValue);
    if (reason === null) {
      continue;
    }

    const fallbackValue = rule.resolveFallback(record);
    patched ??= { ...record };
    patched[rule.field] = fallbackValue;
    diagnostics.push({
      field: rule.field,
      rawValue: present ? rawValue : undefined,
      fallbackValue,
      reason,
      allowedValues: rule.allowed,
    });
  }

  return { value: patched ?? record, diagnostics };
}

/** One-line summary per rewrite, for terminal output. */
export function describeNormalization(diagnostic: EnumNormalizationDiagnostic): string {
  const raw = diagnostic.reason === "missing_field" ? "(absent)" : JSON.stringify(diagnostic.rawValue);
  return `${diagnostic.field}: ${raw} → ${JSON.stringify(diagnostic.fallbackValue)} (${diagnostic.reason})`;
}

/**
 * Diagnostics are carried out-of-band rather than added to the parsed object,
 * so the validated analysis keeps exactly the shape the schema describes. A
 * WeakMap keyed on the fresh object Zod returns is safe under concurrency in a
 * way a module-level "last result" variable would not be.
 */
const diagnosticsByOutput = new WeakMap<object, EnumNormalizationDiagnostic[]>();

export function recordNormalizationDiagnostics(output: unknown, diagnostics: EnumNormalizationDiagnostic[]): void {
  if (diagnostics.length > 0 && output !== null && typeof output === "object") {
    diagnosticsByOutput.set(output, diagnostics);
  }
}

export function readNormalizationDiagnostics(output: unknown): EnumNormalizationDiagnostic[] {
  if (output === null || typeof output !== "object") {
    return [];
  }
  return diagnosticsByOutput.get(output) ?? [];
}
