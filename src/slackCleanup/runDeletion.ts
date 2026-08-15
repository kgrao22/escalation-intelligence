import type { DeletionResultItem } from "../persistence/deletionReceiptOutput.js";
import type { SlackDeleteFn } from "./client.js";
import { assertCleanupSafety, type DeletionTarget } from "./collectDeletionTargets.js";

/** Slack's code for a message that is already gone. */
const ALREADY_GONE = new Set(["message_not_found", "channel_not_found"]);

export interface RunDeletionParams {
  targets: DeletionTarget[];
  windowTag: string;
  deleteFn: SlackDeleteFn;
  onProgress?: (result: DeletionResultItem, index: number, total: number) => void;
}

/**
 * Deletes each target in the order given (replies first, parent last).
 *
 * Idempotent by design: `message_not_found` means the message is already gone,
 * which is the desired end state, so it is recorded as `already_deleted` rather
 * than a failure. That makes the command safe to re-run after a partial pass.
 * A genuine failure is recorded and the run continues, so one bad message does
 * not strand the rest.
 */
export async function runDeletion(params: RunDeletionParams): Promise<DeletionResultItem[]> {
  // Re-assert safety immediately before any live call.
  assertCleanupSafety(params.targets, params.windowTag);

  const results: DeletionResultItem[] = [];
  const total = params.targets.length;

  for (const [index, target] of params.targets.entries()) {
    const base = {
      ts: target.ts,
      kind: target.kind,
      sourceReceiptFile: target.sourceReceiptFile,
      sourceRunId: target.sourceRunId,
    };

    let result: DeletionResultItem;
    try {
      const response = await params.deleteFn({ channel: target.channelId, ts: target.ts });
      if (response.ok) {
        result = { ...base, outcome: "deleted" };
      } else if (response.error && ALREADY_GONE.has(response.error)) {
        result = { ...base, outcome: "already_deleted", error: response.error };
      } else {
        result = { ...base, outcome: "failed", error: response.error ?? "unknown error" };
      }
    } catch (err) {
      result = { ...base, outcome: "failed", error: err instanceof Error ? err.message : String(err) };
    }

    results.push(result);
    params.onProgress?.(result, index + 1, total);
  }

  return results;
}
