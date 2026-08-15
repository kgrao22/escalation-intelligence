import type { SlackPreviewOutput } from "../persistence/slackPreviewOutput.js";

export interface PlannedMessage {
  /** 1-based position in the publication order. */
  index: number;
  type: "overview" | "issue";
  text: string;
  groupId?: string;
  /** False only for the overview; every issue detail is a reply. */
  threadReply: boolean;
}

/**
 * Builds the ordered publication plan.
 *
 * `limit` counts TOTAL messages, overview included — so `--limit=1` publishes
 * only the overview, `--limit=2` publishes the overview plus the first issue.
 * A limit larger than the available messages is capped rather than rejected.
 */
export function buildPublicationPlan(preview: SlackPreviewOutput, limit?: number): PlannedMessage[] {
  const plan: PlannedMessage[] = [
    { index: 1, type: "overview", text: preview.overview.text, threadReply: false },
    ...preview.issues.map((issue, offset) => ({
      index: offset + 2,
      type: "issue" as const,
      text: issue.text,
      ...(issue.groupId ? { groupId: issue.groupId } : {}),
      threadReply: true,
    })),
  ];

  if (limit === undefined) {
    return plan;
  }
  return plan.slice(0, Math.max(0, Math.min(limit, plan.length)));
}

/**
 * The messages still outstanding for a preview.
 *
 * Anything already recorded as successfully published is excluded, so a resume
 * can never repost a message that landed — including the overview, which would
 * otherwise start a second thread.
 *
 * `limit` here caps how many of the *remaining* messages to attempt, letting an
 * operator resume cautiously one reply at a time.
 */
export function buildResumePlan(
  preview: SlackPreviewOutput,
  publishedIndexes: ReadonlySet<number>,
  limit?: number,
): PlannedMessage[] {
  const remaining = buildPublicationPlan(preview).filter((message) => !publishedIndexes.has(message.index));
  if (limit === undefined) {
    return remaining;
  }
  return remaining.slice(0, Math.max(0, Math.min(limit, remaining.length)));
}

export function describePlanLine(message: PlannedMessage): string {
  if (message.type === "overview") {
    return `${message.index}. TOP LEVEL — overview`;
  }
  return `${message.index}. THREAD REPLY — issue ${message.index - 1}`;
}
