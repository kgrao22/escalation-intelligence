# Escalation Intelligence — Project Plan

> **Status:** Revised after initial planning to reflect the final MVP
> direction — the MVP now integrates with **live, read-only production
> Slack data** from day one, runs entirely **locally** on a single machine,
> and defers the database/dashboard/cloud-deployment work to later phases.
> The original plan's core analytical ideas (no predefined taxonomy,
> embeddings + clustering, transparent scoring) are unchanged — what changed
> is sequencing and infrastructure weight.

## 1. Problem Statement

The `#escalations-technology` Slack channel (channel ID `C0SOURCE0000`)
accumulates a stream of ad-hoc incident reports (e.g. "Vehicle upload failed
for 300 vehicles", "Bulk fleet upload keeps timing out"). These messages are
read once, handled, and forgotten. Nobody aggregates them, so:

- The team has no visibility into which technical problems recur most often.
- Engineering effort is spent firefighting the same underlying issues
  repeatedly instead of fixing them permanently or automating around them.
- There is no data-driven way to prioritize reliability/automation work.

**Goal:** Periodically read recent escalation threads from
`#escalations-technology`, identify recurring, named problems, score each
for automation potential, and publish a readable intelligence report to a
separate channel, `#escalations-intelligence` (channel ID `C0DEST00000`) —
without ever writing to the source channel.

## 2. MVP Scope

The MVP is a **local CLI application** that:

1. Reads real (but read-only) data from `#escalations-technology` via the
   Slack Web API, for a configurable trailing window (default 30 days).
2. Filters threads down to genuine technical escalations (vs. chit-chat,
   acknowledgements, off-topic messages).
3. Uses an LLM to normalize each genuine escalation into a concise,
   de-identified problem statement plus structured metadata (system,
   severity, customer impact, root cause, resolution status).
4. Embeds the normalized statements and clusters them to discover recurring
   patterns — with no predefined issue taxonomy.
5. Names each cluster via an LLM, and computes frequency/trend and an
   automation-opportunity score per cluster.
6. Formats a readable report and — only after an explicit **dry run** step
   the operator reviews — publishes it to `#escalations-intelligence`.
7. Runs entirely on a developer's MacBook via `npm run intelligence`, with
   no server, database service, or container required for the MVP.

This document builds the MVP in small milestones (§13); **this revision
implements only Milestone 0 and Milestone 1** — project scaffold and a
read-only Slack connectivity probe. LLM analysis, embeddings, clustering,
and persistence come in later milestones.

## 3. Non-Goals (for MVP — see §14 for later phases)

- **No cloud deployment.** The MVP runs locally only; cloud hosting (Fly.io,
  Railway, Vercel, etc.) is a later phase, not required to prove value.
- **No database service (Postgres/pgvector) required for MVP.** Early
  milestones can hold intermediate data in memory or simple local JSON/
  SQLite files; a proper embedded **SQLite** database is introduced once
  persistence is actually needed (Milestone 6+), not a server-based DB.
- **No web dashboard.** Output is a formatted Slack message in
  `#escalations-intelligence`. A dashboard is a later phase.
- **No writes of any kind to the source channel.** `#escalations-technology`
  is production and strictly read-only — no `chat.postMessage`,
  `chat.update`, `reactions.add`, or any mutating call is ever issued
  against it (see §11).
- **No predefined issue taxonomy.** Categories emerge from clustering, not
  a hardcoded enum. This is a permanent design principle.
- **No Slack Events API / Socket Mode / real-time ingestion.** The MVP polls
  on demand via a CLI command; live/real-time ingestion is a later phase.
- **No scheduling/automation of runs.** The operator runs the CLI by hand;
  cron/scheduled execution is a later phase.
- **No auto-publishing without review.** Every run supports (and Milestone-
  wise, requires before real publishing is added) a dry-run mode that shows
  the report without posting it.
- **No microservices, queues, or background workers.** A single Node.js CLI
  process is sufficient at this data volume.

## 4. Architecture

A **local, single-process CLI application** — no server, no persistent
process:

```
┌───────────────────────────────────────────────────────────────────┐
│                    Escalation Intelligence CLI                     │
│                      (Node.js + TypeScript)                        │
│                                                                     │
│   npm run slack:probe        npm run intelligence -- --days=30     │
│         │                              │                            │
│         ▼                              ▼                            │
│  ┌─────────────┐              ┌─────────────────────────────────┐  │
│  │ Connectivity │              │  Pipeline (later milestones):   │  │
│  │ probe        │              │  fetch → filter → normalize →   │  │
│  │ (Milestone 1)│              │  embed → cluster → name →        │  │
│  │              │              │  score → report → dry-run/publish│  │
│  └──────┬───────┘              └────────────────┬────────────────┘  │
│         │                                        │                   │
│         └───────────────┬────────────────────────┘                   │
│                          ▼                                           │
│                 ┌──────────────────┐                                 │
│                 │  Slack client    │  read-only methods only,        │
│                 │  wrapper         │  posting confined to a          │
│                 │  (@slack/web-api)│  separate, guarded module       │
│                 └────────┬─────────┘                                 │
└──────────────────────────┼───────────────────────────────────────────┘
                            │
                 ┌──────────┴──────────┐
                 ▼                     ▼
     #escalations-technology   #escalations-intelligence
        (C0SOURCE0000)               (C0DEST00000)
        READ ONLY                   REPORT OUTPUT ONLY
```

Key architectural decisions:

- **CLI-first, not server-first.** There is no long-running process and no
  web framework in the MVP. This directly matches "runs locally, no cloud
  deployment required" and keeps the dependency graph minimal.
- **Slack read and Slack write are architecturally separated.** The client
  wrapper module used by the probe and the fetch pipeline exposes *only*
  read methods (`auth.test`, `conversations.info`, `conversations.history`,
  `conversations.replies`). A distinct, later-added publishing module is the
  only code path allowed to call `chat.postMessage`, and it carries an
  explicit runtime guard (§11) rejecting any attempt to post to the source
  channel ID.
- **Persistence is introduced only when needed, and stays local.** Early
  milestones need no storage beyond in-memory data structures for a single
  run. When a pipeline run needs to persist results across runs (dedup,
  historical trend), an embedded **SQLite** file (via `better-sqlite3` or
  `drizzle-orm` + SQLite driver) is used — no database server process, no
  Docker. This can migrate to Postgres later only if/when multi-user or
  cloud deployment actually requires it (§14).
- **Configuration is centralized and validated.** All environment variables
  are parsed and validated once (Zod schema in `src/config/env.ts`) at
  startup; nothing reads `process.env` directly elsewhere.

## 5. Data Flow

```
1. Operator runs `npm run intelligence -- --days=30` (or slack:probe for
   the lightweight connectivity check)
        │
        ▼
2. Fetch: read top-level messages from #escalations-technology for the
   configured trailing window, then fetch each thread's replies
   (conversations.history + conversations.replies) — READ ONLY
        │
        ▼
3. Filter: identify which threads are genuine technical escalations
   (vs. FYI/social/off-topic messages) — an LLM classification pass, or a
   lightweight heuristic first, before spending LLM/embedding budget on
   everything
        │
        ▼
4. Normalize: for each genuine escalation thread, call an LLM to produce
   a normalized_problem_statement + structured metadata (system, severity,
   customer impact, suspected root cause, resolved?, PII flag) — Slack
   permalink retained for traceability
        │
        ▼
5. Embed: generate an embedding vector for each normalized_problem_statement
        │
        ▼
6. Cluster: group semantically similar escalations with no predefined
   taxonomy; one-off issues may remain unclustered
        │
        ▼
7. Name: LLM assigns a short human-readable name + description per cluster
        │
        ▼
8. Analyze: compute frequency and trend per cluster over the window, and an
   automation-opportunity score
        │
        ▼
9. Report: format a readable summary (top recurring issues, scores,
   trends, links back to source threads via Slack permalinks)
        │
        ▼
10. Dry run: print/preview the report; only on explicit confirmation
    (flag or prompt) does the app call chat.postMessage against
    #escalations-intelligence — never against the source channel
```

**This revision implements steps 1–2 only** (fetch, as a connectivity probe
capped at 5 messages) — steps 3–10 are later milestones (§13).

## 6. Proposed Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript** (strict mode) | Type safety across config, Slack payloads, and (later) LLM/embedding schemas. |
| Runtime | **Node.js**, local CLI | No server process needed; matches "runs on my MacBook" requirement. |
| Slack SDK | **`@slack/web-api`** (official SDK) | Well-maintained, typed, minimal boilerplate for `auth.test`, `conversations.*`, and (later) `chat.postMessage`. |
| Env/config | **`dotenv` + Zod** | `dotenv` loads `.env.local`; Zod validates required vars fail fast with clear errors instead of `undefined` surprises deep in the code. |
| CLI arg parsing | Node's built-in `util.parseArgs` (no extra dependency) | Only need `--days=N` for MVP; avoids pulling in `commander`/`yargs` before they're needed. |
| Testing | **Vitest** | Fast, TypeScript-native, minimal config; used for env validation and Slack safety-guard unit tests. |
| Persistence (MVP) | None yet (Milestone 0/1); **SQLite** later (Milestone 6+) | Deferred until a real need (cross-run dedup/history) exists — see §4. |
| LLM (later) | **Anthropic API** (Claude) | Structured extraction, cluster labeling, automatability scoring. |
| Embeddings (later) | Hosted embeddings API (e.g. Voyage AI) | No predefined taxonomy — semantic similarity drives clustering. |
| Dashboard | **None in MVP** — output is a Slack report | Deferred; see §14. |
| Deployment | **None — local execution only** | Deferred; see §14. |

**Explicitly deferred, not rejected:** Next.js, Postgres, pgvector, Docker,
Cloud Run/Fly.io/Railway, queues, microservices, background workers, a web
dashboard, cron scheduling, Slack Events API, Socket Mode. All were part of
the original plan and remain the intended direction for later phases (§14)
— they are simply not needed to answer the MVP's first question: *can this
application safely read real messages from `#escalations-technology`?*

## 7. Proposed Database Schema (Later Phase — Not in Milestone 0/1)

No database is created in this revision. Once persistence is introduced
(Milestone 6+), the MVP schema will use **SQLite** with a shape adapted
from the earlier Postgres design — the tables below are the intended
target once that milestone starts, kept here for continuity:

```sql
-- escalations: raw fetched messages/replies (read-only mirror, minimal fields)
-- escalation_threads: one row per analyzed thread (root + replies collapsed)
-- extractions: LLM-normalized problem statement + structured metadata
-- embeddings: vector per extraction (stored as a serialized array/BLOB in
--   SQLite, since SQLite has no native vector type at MVP scale — a brute
--   force cosine-similarity scan in Node is fine for a few thousand rows)
-- clusters: LLM-named recurring issue groups + scores
-- cluster_assignments: extraction ↔ cluster membership per pipeline run
-- pipeline_runs: metadata about each run, including dry-run vs. published
```

`pgvector`/Postgres remains the plan **if and when** data volume or
multi-user/cloud requirements justify it (§14) — not required to prove the
MVP.

## 8. LLM Extraction Schema (Later Phase — Design Carried Forward)

Unchanged in spirit from the original plan, with two fields added to match
the final MVP direction (resolution status, explicit root-cause field):

```typescript
interface EscalationExtraction {
  normalized_problem_statement: string;
  // Concise, de-identified restatement of the core problem, e.g.
  // "Bulk vehicle upload fails or times out for large files"
  // Customer names, order/VIN/account IDs, etc. are stripped.

  affected_system: string | null;      // free text, not a fixed enum
  severity: "low" | "medium" | "high" | "critical" | null;
  is_customer_impacting: boolean | null;
  suspected_root_cause: string | null;
  is_resolved: boolean | null;         // was the thread marked/implied resolved?
  looks_automatable: boolean | null;   // first-pass signal, refined later by cluster-level scoring
  mentions_pii_or_customer_data: boolean;
  extraction_confidence: number;       // 0.0–1.0
  slack_permalink: string;             // retained for traceability/drill-down
}
```

This schema is **not implemented in Milestone 0/1** — it is documented here
so later milestones build toward a settled target.

## 9. Clustering Strategy (Later Phase — Design Carried Forward)

Unchanged from the original plan:

1. Embed `normalized_problem_statement` (not raw Slack text) — normalization
   removes noise that would otherwise hurt semantic similarity.
2. Use density-based clustering (e.g. HDBSCAN, or agglomerative clustering
   over cosine distance as a simpler first pass) — chosen because the
   number of clusters isn't known in advance and one-off issues should be
   allowed to remain unclustered rather than forced into a group.
3. For each cluster, sample representative statements and ask an LLM to
   generate a short name + description — the taxonomy is discovered
   bottom-up, never predefined.
4. MVP re-clustering is a full batch recompute per run; cluster identity
   stability across runs is a later refinement (§14).

## 10. Automation-Opportunity Scoring Strategy (Later Phase — Design Carried Forward)

Unchanged from the original plan — a transparent, explainable formula, not
a black box:

```
automation_opportunity_score =
    w1 * normalized(frequency)
  + w2 * normalized(trend)
  + w3 * normalized(severity_avg)
  + w4 * automatability_estimate   -- separate LLM call per cluster, with rationale
```

The report always shows the score **and** its breakdown, never a bare
number.

## 11. Security & Privacy Considerations

Slack messages in an escalations channel will likely contain customer
names, account/order/VIN identifiers, and internal system details. The
final MVP direction adds concrete, code-enforced guardrails on top of the
general principles from the original plan:

1. **Source channel is strictly read-only, enforced in code, not just by
   convention.** The Slack client wrapper used for fetching exposes *only*
   read methods (`auth.test`, `conversations.info`, `conversations.history`,
   `conversations.replies`). No mutating Slack method
   (`chat.postMessage`, `chat.update`, `chat.delete`, `reactions.add`,
   `conversations.archive`, `conversations.rename`, `pins.add`, or any other
   write/mutate call) is implemented against the source channel — full
   stop, not just "not called in this milestone."
2. **Explicit runtime safety guard against cross-posting.** Before any
   future `chat.postMessage` call (not implemented until a later milestone),
   the code must check `destinationChannelId === sourceChannelId` and
   **refuse to post** if true, regardless of how it was invoked. This
   revision's Milestone 1 probe also verifies source ≠ destination as a
   precondition and exits with an error otherwise.
3. **Least-privilege Slack scopes.** Request only `channels:read` +
   `channels:history` (read) for the MVP; `chat:write` is added only when
   report publishing is implemented (later milestone). If either channel
   turns out to be private, `groups:read`/`groups:history` replace the
   `channels:*` equivalents — never request workspace-wide scopes.
4. **Secrets never hardcoded, never logged, never printed.** `SLACK_BOT_TOKEN`
   is read only from environment variables (via `.env.local`, which is
   git-ignored). No code path logs, prints, or includes the token or
   `Authorization` header in error messages, stack traces, or console
   output. `.env.example` documents required variable *names* with safe
   placeholder values only.
5. **Data minimization at normalization time** (later milestone). The LLM
   normalization prompt strips specific identifiers (names, emails, order/
   VIN/account IDs) from the `normalized_problem_statement`, preserving only
   the technical pattern.
6. **PII flag carried through the pipeline** (later milestone). A
   `mentions_pii_or_customer_data` field lets later stages (and the
   published report) avoid surfacing sensitive raw content.
7. **Minimal console output from the connectivity probe.** Per Milestone 1
   requirements, the probe prints truncated message previews, not full
   message bodies, and never the bot token.
8. **Local-only execution reduces exposure for MVP.** Because the MVP runs
   on the operator's own machine rather than a hosted service, there is no
   publicly reachable endpoint or shared database to secure yet — this is a
   deliberate reason to defer cloud deployment until the analytical
   pipeline is proven (§14 covers what changes once it's hosted).

## 12. External Accounts / API Credentials Needed

| When | Account/Credential | Purpose |
|---|---|---|
| MVP (now) | **Slack Bot Token** (`SLACK_BOT_TOKEN`, `xoxb-...`) for a Slack app installed in the workspace, scoped to `channels:read` + `channels:history` (or `groups:*` if channels are private) | Read `#escalations-technology`; later, `chat:write` is added for publishing to `#escalations-intelligence` |
| Later | **Anthropic API key** | LLM normalization, filtering, cluster labeling, automatability scoring |
| Later | **Embeddings provider API key** (e.g. Voyage AI) | Generating embedding vectors |
| Later (only if hosted) | Hosting platform account (Fly.io/Railway/Vercel) + managed Postgres | Only once cloud deployment phase begins |
| Later | Error tracking (e.g. Sentry) | Once running unattended/scheduled or hosted |

No database or hosting account is required for Milestone 0/1.

## 13. Development Roadmap (Milestones)

**Milestone 0 — Project scaffold** *(this revision)*
TypeScript CLI project (strict mode), Zod-validated env config, `.env.example`
with safe placeholders, `.gitignore` excluding `.env.local`, `npm run
typecheck` / `test` / `slack:probe` scripts, Vitest set up with tests for env
validation and the source≠destination safety guard. No Slack calls yet.

**Milestone 1 — Slack connectivity probe** *(this revision)*
Read-only probe: `auth.test`, verify both channel IDs are accessible,
fetch up to 5 recent top-level messages from the source channel only, print
safe metadata (timestamp, author ID, reply count, truncated preview). Prints
explicit `SOURCE: READ ONLY` / `DESTINATION: REPORT OUTPUT ONLY` markers and
confirms source ≠ destination. No posting capability exists in the codebase
yet.

**Milestone 2 — Full thread fetch for the configured window**
Extend fetching beyond the 5-message probe cap to the full configurable
`--days` window, paginating `conversations.history`, and fetching full
thread replies (`conversations.replies`) for each root message. Still
read-only, still no LLM/embeddings.

**Milestone 3 — Technical-escalation filtering**
Classify fetched threads as genuine technical escalations vs. noise
(social messages, acknowledgements, off-topic) — starting with a cheap
heuristic and/or a first LLM pass — before spending LLM/embedding budget on
everything downstream.

**Milestone 4 — LLM normalization**
Implement the extraction schema from §8 against the Anthropic API for
filtered threads, including PII-stripping in the normalized statement.

**Milestone 5 — Embeddings + clustering**
Generate embeddings for normalized statements; implement clustering
(§9) with no predefined taxonomy; LLM-based cluster naming.

**Milestone 6 — Persistence (SQLite)**
Introduce local SQLite storage for run history, dedup across runs, and
frequency/trend calculation over time (requires knowing what was seen in
prior runs).

**Milestone 7 — Frequency/trend + automation scoring**
Implement the scoring formula from §10 with full breakdown per cluster.

**Milestone 8 — Report formatting + dry run**
Format a readable Slack-message report (top clusters, scores, trends,
permalinks). Dry-run mode prints/previews the report without posting.

**Milestone 9 — Guarded publishing to `#escalations-intelligence`**
Implement `chat.postMessage` in a dedicated, isolated module carrying the
source≠destination guard from §11; require an explicit flag/confirmation
to move from dry-run to actually posting.

**Milestone 10 — Scheduling (optional, local)**
Optional local scheduling (e.g. `launchd`/cron calling the CLI) to run
periodically without cloud infrastructure.

*(Milestones 11+ — dashboard, cloud deployment, Postgres/pgvector,
Slack Events API — belong to Phase 2/3, detailed in §14.)*

## 14. Future Improvements (Explicitly Out of MVP)

- **Web dashboard** for browsing clusters/trends instead of (or alongside)
  the Slack report.
- **Cloud deployment** (Fly.io/Railway/Vercel) once the pipeline's value is
  proven locally.
- **Postgres + pgvector** if data volume, multi-user access, or hosted
  deployment outgrows a local SQLite file.
- **Live/real-time ingestion** via Slack Events API or Socket Mode, instead
  of on-demand polling.
- **Scheduled cloud runs** (replacing local `launchd`/cron) once hosted.
- **Cluster stability across runs** (match new clusters to prior runs'
  clusters so a recurring issue keeps a stable identity over time).
- **Incremental clustering** instead of full recompute per run.
- **Feedback loop**: let humans mark a cluster "actually fixed," "not
  automatable," or "mis-clustered" in the destination channel or a
  dashboard, feeding back into scoring.
- **Multi-channel / multi-workspace support.**
- **Automated ticket creation** (Jira/Linear) for high-scoring clusters.
- **Alerting** when a new high-scoring cluster emerges or trends up sharply.
- **Dedicated PII redaction pipeline** beyond LLM best-effort normalization.
- **Auth/roles** if/when a dashboard or hosted deployment exposes this more
  broadly than a single operator's machine.
