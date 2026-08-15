import type { ReviewPreviewArtifact } from "./buildReviewPreview.js";
import type { SlackPostFn } from "../slackPublishing/client.js";
import { assertWriteTarget, EXPECTED_DESTINATION_CHANNEL_ID, FORBIDDEN_SOURCE_CHANNEL_ID, PublicationSafetyError } from "../slackPublishing/safety.js";

export interface ReviewPublicationResultItem {
  index: number;
  kind: "parent" | "reply";
  title: string;
  status: "success" | "failed" | "skipped";
  slackTs?: string;
  error?: string;
}

export interface PriorReviewPublication {
  previewInputFile?: string;
  status?: string;
  parentTs?: string | null;
  results?: ReviewPublicationResultItem[];
}

/**
 * Indexes what a prior run already posted, so a resumed run never reposts a
 * message that succeeded. Only successes with a real timestamp count.
 */
export function buildPublishedIndex(priors: PriorReviewPublication[], previewInputFile: string): Map<number, string> {
  const index = new Map<number, string>();
  for (const prior of priors) {
    if (prior.previewInputFile !== previewInputFile) {
      continue;
    }
    for (const result of prior.results ?? []) {
      if (result.status === "success" && result.slackTs) {
        index.set(result.index, result.slackTs);
      }
    }
  }
  return index;
}

/** A preview is fully published when every one of its messages has a timestamp. */
export function isPublicationComplete(preview: ReviewPreviewArtifact, published: Map<number, string>): boolean {
  return preview.messages.every((message) => published.has(message.index));
}

export function resolveParentTs(
  priors: PriorReviewPublication[],
  previewInputFile: string,
  published: Map<number, string>,
): string | undefined {
  const fromResults = published.get(1);
  if (fromResults) {
    return fromResults;
  }
  return priors.find((p) => p.previewInputFile === previewInputFile && p.parentTs)?.parentTs ?? undefined;
}

export interface RunReviewPublicationParams {
  preview: ReviewPreviewArtifact;
  postFn: SlackPostFn;
  published?: Map<number, string>;
  parentTs?: string;
  onProgress?: (result: ReviewPublicationResultItem) => void;
}

/**
 * Posts the parent first, then each reply into that thread.
 *
 * The parent must exist before any reply can be threaded, so a failed parent
 * aborts rather than scattering orphaned replies into the channel. The channel
 * is re-asserted on every single write.
 */
export async function runReviewPublication(
  params: RunReviewPublicationParams,
): Promise<{ results: ReviewPublicationResultItem[]; parentTs?: string }> {
  const published = params.published ?? new Map<number, string>();
  const results: ReviewPublicationResultItem[] = [];

  const destination = params.preview.metadata.destinationChannelId;
  if (destination === FORBIDDEN_SOURCE_CHANNEL_ID) {
    throw new PublicationSafetyError(`Refusing to write to the source channel ${FORBIDDEN_SOURCE_CHANNEL_ID}.`);
  }
  if (destination !== EXPECTED_DESTINATION_CHANNEL_ID) {
    throw new PublicationSafetyError(
      `Preview declares destination ${destination}; only ${EXPECTED_DESTINATION_CHANNEL_ID} is permitted.`,
    );
  }

  const parent = params.preview.messages.find((message) => message.kind === "parent");
  if (!parent) {
    throw new PublicationSafetyError("Preview contains no parent message.");
  }

  let parentTs = params.parentTs ?? published.get(parent.index);

  if (parentTs) {
    const skipped: ReviewPublicationResultItem = {
      index: parent.index, kind: "parent", title: parent.title, status: "skipped", slackTs: parentTs,
    };
    results.push(skipped);
    params.onProgress?.(skipped);
  } else {
    assertWriteTarget(destination);
    try {
      const response = await params.postFn({ channel: destination, text: parent.text });
      parentTs = response.ts;
      const ok: ReviewPublicationResultItem = {
        index: parent.index, kind: "parent", title: parent.title, status: "success", slackTs: parentTs,
      };
      results.push(ok);
      params.onProgress?.(ok);
    } catch (err) {
      const failed: ReviewPublicationResultItem = {
        index: parent.index, kind: "parent", title: parent.title, status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
      results.push(failed);
      params.onProgress?.(failed);
      // Without a parent there is no thread to reply into.
      return { results };
    }
  }

  for (const message of params.preview.messages.filter((m) => m.kind === "reply")) {
    const already = published.get(message.index);
    if (already) {
      const skipped: ReviewPublicationResultItem = {
        index: message.index, kind: "reply", title: message.title, status: "skipped", slackTs: already,
      };
      results.push(skipped);
      params.onProgress?.(skipped);
      continue;
    }

    assertWriteTarget(destination);
    try {
      const response = await params.postFn({ channel: destination, text: message.text, thread_ts: parentTs });
      const ok: ReviewPublicationResultItem = {
        index: message.index, kind: "reply", title: message.title, status: "success", slackTs: response.ts,
      };
      results.push(ok);
      params.onProgress?.(ok);
    } catch (err) {
      const failed: ReviewPublicationResultItem = {
        index: message.index, kind: "reply", title: message.title, status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
      results.push(failed);
      params.onProgress?.(failed);
    }
  }

  return { results, parentTs };
}
