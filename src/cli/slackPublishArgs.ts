import { parseArgs } from "node:util";

export interface SlackPublishArgs {
  input?: string;
  /** Fail-closed: writes happen only when this is explicitly true. */
  publish: boolean;
  /** Continue an existing publication instead of starting a new one. */
  resume: boolean;
  limit?: number;
}

export function parseSlackPublishArgs(argv: string[]): SlackPublishArgs {
  // Reject a destination override loudly rather than ignoring it. Silently
  // dropping the flag would let someone believe they had redirected output.
  const override = argv.find((arg) => arg === "--channel" || arg.startsWith("--channel="));
  if (override) {
    throw new Error(
      "--channel is not supported. The destination is fixed in code and cannot be overridden from the CLI.",
    );
  }

  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: "string" },
      publish: { type: "boolean", default: false },
      resume: { type: "boolean", default: false },
      limit: { type: "string" },
    },
    strict: false,
  });

  let limit: number | undefined;
  if (values.limit !== undefined) {
    const parsed = Number.parseInt(String(values.limit), 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`Invalid --limit value: "${values.limit}". Must be a positive integer.`);
    }
    limit = parsed;
  }

  return {
    input: values.input !== undefined ? String(values.input) : undefined,
    publish: Boolean(values.publish),
    resume: Boolean(values.resume),
    limit,
  };
}
