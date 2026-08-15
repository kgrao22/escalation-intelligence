import type { EscalationThread } from "../slack/escalationThreads.js";

/**
 * Matches automated Jira-sync bot noise (e.g. "@Krishna created a Task
 * UP-4265 ..." or "synced this conversation thread with the Jira work
 * item ..."). Deliberately narrow: a normal human reply that happens to
 * contain a Jira URL or mentions "Jira" in passing must NOT match — only
 * the bot's own repetitive announcement text should.
 */
const JIRA_SYNC_NOISE_PATTERNS: RegExp[] = [
  /\bcreated (a|an) (task|story|bug|sub-task|epic)\s+[A-Z][A-Z0-9]*-\d+/i,
  /\bsynced this (conversation )?thread with the jira (work item|issue)\b/i,
  /\bmirrored (this|the) (thread|conversation) (to|with) jira\b/i,
  /\blinked this thread to jira (issue|work item)\s+[A-Z][A-Z0-9]*-\d+/i,
];

export function isJiraSyncNoise(text: string): boolean {
  return JIRA_SYNC_NOISE_PATTERNS.some((pattern) => pattern.test(text));
}

export interface CleanedThread {
  /** What actually gets sent to the LLM as the user-turn content. */
  combinedText: string;
  originalReplyCount: number;
  keptReplyCount: number;
  jiraNoiseRemoved: number;
}

/**
 * Keeps the root message and all human/technical replies; drops only
 * repetitive Jira-sync-bot announcements. Reduces automation noise while
 * preserving diagnosis, root cause, workaround, and resolution discussion —
 * including replies that happen to contain a Jira URL alongside real content.
 */
export function preprocessThreadForLLM(thread: EscalationThread): CleanedThread {
  const keptReplies = thread.replies.filter((reply) => !isJiraSyncNoise(reply.text));
  const jiraNoiseRemoved = thread.replies.length - keptReplies.length;

  const sections = [`ROOT MESSAGE:\n${thread.rootText}`];
  keptReplies.forEach((reply, index) => {
    sections.push(`REPLY ${index + 1}:\n${reply.text}`);
  });

  return {
    combinedText: sections.join("\n\n"),
    originalReplyCount: thread.replies.length,
    keptReplyCount: keptReplies.length,
    jiraNoiseRemoved,
  };
}
