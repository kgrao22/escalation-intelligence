/**
 * Buckets used across the report. Each is listed in the order it should be
 * rendered — most severe / most impactful / most open first — so any renderer
 * gets a sensible ordering without re-deriving it.
 *
 * `unspecified` is a distinct bucket everywhere rather than being folded into
 * an existing enum value: an extraction that never established a severity is
 * not the same thing as one judged "low", and conflating them would overstate
 * confidence in the report.
 */
export const SEVERITY_ORDER = ["critical", "high", "medium", "low", "unspecified"] as const;
export const CUSTOMER_IMPACT_ORDER = [
  "multiple_customers",
  "single_customer",
  "none",
  "unknown",
  "unspecified",
] as const;
export const RESOLUTION_STATUS_ORDER = [
  "unresolved",
  "workaround",
  "resolved",
  "not_applicable",
  "unclear",
  "unspecified",
] as const;

export type SeverityBucket = (typeof SEVERITY_ORDER)[number];
export type CustomerImpactBucket = (typeof CUSTOMER_IMPACT_ORDER)[number];
export type ResolutionStatusBucket = (typeof RESOLUTION_STATUS_ORDER)[number];

export interface DistributionEntry<T extends string> {
  value: T;
  count: number;
}

/** Ranks used only for tie-breaking the report ordering, never as a score. */
export const SEVERITY_RANK: Record<SeverityBucket, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  unspecified: 0,
};

export const CUSTOMER_IMPACT_RANK: Record<CustomerImpactBucket, number> = {
  multiple_customers: 3,
  single_customer: 2,
  none: 1,
  unknown: 0,
  unspecified: 0,
};

function toBucket<T extends string>(value: string | null | undefined, allowed: readonly T[]): T {
  if (value === null || value === undefined || value === "") {
    return "unspecified" as T;
  }
  return (allowed as readonly string[]).includes(value) ? (value as T) : ("unspecified" as T);
}

export const toSeverityBucket = (value: string | null | undefined): SeverityBucket =>
  toBucket(value, SEVERITY_ORDER);
export const toCustomerImpactBucket = (value: string | null | undefined): CustomerImpactBucket =>
  toBucket(value, CUSTOMER_IMPACT_ORDER);
export const toResolutionStatusBucket = (value: string | null | undefined): ResolutionStatusBucket =>
  toBucket(value, RESOLUTION_STATUS_ORDER);

/**
 * Counts values into the canonical bucket order. Empty buckets are retained
 * so every group's distribution has the same shape — a renderer can rely on
 * the array without null-checking, and a zero is meaningful information.
 */
export function distribute<T extends string>(values: T[], order: readonly T[]): Array<DistributionEntry<T>> {
  return order.map((value) => ({ value, count: values.filter((candidate) => candidate === value).length }));
}
