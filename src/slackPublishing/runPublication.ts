import type {
  PublicationFailureRecord,
  PublicationReceipt,
  PublishedMessageRecord,
} from "../persistence/publicationReceipt.js";
import type { Publisher } from "./client.js";
import type { PlannedMessage } from "./publishPlan.js";

export interface PublicationProgressEvent {
  index: number;
  total: number;
  type: "overview" | "issue";
  label: string;
  outcome: "success" | "failed";
  slackTs?: string;
  errorMessage?: string;
}

export interface RunPublicationParams {
  plan: PlannedMessage[];
  publisher: Publisher;
  previewInputFile: string;
  destinationChannelId: string;
  runId: string;
  startedAt: Date;
  /**
   * Thread root from an earlier run. Supplied when resuming, so replies join
   * the original thread instead of needing a fresh overview.
   */
  resumeOverviewTs?: string;
  now?: () => Date;
  /** Human-readable label per message, for progress output only. */
  labelFor?: (message: PlannedMessage) => string;
  onProgress?: (event: PublicationProgressEvent) => void;
}

function defaultLabel(message: PlannedMessage): string {
  return message.type === "overview" ? "overview" : (message.groupId ?? `issue ${message.index - 1}`);
}

/**
 * Posts the plan: the overview as a top-level message, then every issue detail
 * as a reply in that thread.
 *
 * If the overview fails there is no thread to reply into, so the run stops
 * immediately with status `failed` and nothing further is attempted. If an
 * individual reply fails the run continues and records the failure — one bad
 * message should not abandon the replies after it, and the receipt captures
 * exactly what landed so nothing is republished blindly.
 */
export async function runPublication(params: RunPublicationParams): Promise<PublicationReceipt> {
  const now = params.now ?? (() => new Date());
  const label = params.labelFor ?? defaultLabel;
  const total = params.plan.length;

  const publishedMessages: PublishedMessageRecord[] = [];
  const failures: PublicationFailureRecord[] = [];
  // On a resume the thread root already exists; replies join it directly.
  let overviewTs: string | null = params.resumeOverviewTs ?? null;

  const receipt = (status: PublicationReceipt["status"]): PublicationReceipt => ({
    runId: params.runId,
    previewInputFile: params.previewInputFile,
    destinationChannelId: params.destinationChannelId,
    startedAt: params.startedAt.toISOString(),
    completedAt: now().toISOString(),
    overviewTs,
    status,
    requestedMessageCount: total,
    publishedMessages,
    failures,
  });

  for (const message of params.plan) {
    try {
      if (message.type === "overview") {
        overviewTs = await params.publisher.postOverview(message.text);
        publishedMessages.push({ index: message.index, type: "overview", slackTs: overviewTs, status: "success" });
        params.onProgress?.({
          index: message.index,
          total,
          type: "overview",
          label: label(message),
          outcome: "success",
          slackTs: overviewTs,
        });
        continue;
      }

      if (overviewTs === null) {
        throw new Error("No overview thread timestamp is available to reply into.");
      }

      const ts = await params.publisher.postThreadReply(message.text, overviewTs);
      publishedMessages.push({
        index: message.index,
        type: "issue",
        ...(message.groupId ? { groupId: message.groupId } : {}),
        slackTs: ts,
        status: "success",
      });
      params.onProgress?.({
        index: message.index,
        total,
        type: "issue",
        label: label(message),
        outcome: "success",
        slackTs: ts,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      failures.push({
        index: message.index,
        type: message.type,
        ...(message.groupId ? { groupId: message.groupId } : {}),
        error: errorMessage,
      });
      params.onProgress?.({
        index: message.index,
        total,
        type: message.type,
        label: label(message),
        outcome: "failed",
        errorMessage,
      });

      if (message.type === "overview") {
        // Without a thread root there is nothing to reply into; stop here
        // rather than scattering issue details as top-level posts.
        return receipt("failed");
      }
    }
  }

  return receipt(failures.length === 0 ? "completed" : "partial_failure");
}
