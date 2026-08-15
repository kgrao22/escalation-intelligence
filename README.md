# Escalation Intelligence

Analyses escalation threads from a Slack channel to surface recurring
technical issues worth automating or permanently fixing. See
[PLAN.md](./PLAN.md) for the full architecture, roadmap, and rationale.

**Current status:** Milestones 0–5. The pipeline can fetch a configurable
window of Slack history, extract structured technical escalations with an
LLM, embed them, and produce a local similarity report. There is **no
clustering**, no cluster naming, no frequency scoring, no automation scoring,
no database persistence, and no report publishing yet — see
[PLAN.md](./PLAN.md) §13 for what comes next.

Milestones 4–5 exist to answer one question before any clustering algorithm
or threshold is chosen: **are the embeddings semantically useful on our
data, and is there enough of it?** The similarity report is evidence for a
human to inspect — it deliberately makes no judgment about what score means
"the same issue". Validation on the 30-day dataset showed embeddings are
useful for *candidate discovery*, but that cosine similarity alone should not
decide whether two escalations are the same recurring engineering issue.

### Dataset windows and filenames

Every artifact is tagged with the lookback window it came from, so a 30-day
and a 90-day run on the same day never overwrite each other:

```
data/slack/escalations-90d-2026-08-09.json
data/intelligence/extractions-90d-2026-08-09.json
data/intelligence/embeddings-90d-2026-08-09.json
```

The tag propagates automatically from the fetch through extraction and
embedding. Files written before window tagging (`escalations-2026-08-09.json`)
are still read normally, so earlier datasets remain usable.

**Every command accepts `--input=<path>`.** When it is omitted, the newest
matching file is auto-selected *and the command prints which file it chose
plus any other candidates it passed over* — so with several windows on disk,
analysing the wrong dataset is never silent. Pass `--input` when you want
certainty.

## Safety model

- **Source channel (`#escalations`) is strictly read-only.** The
  Slack client wrapper (`src/slack/client.ts`) exposes only read methods —
  there is no code path in this repository that can post, edit, react to,
  or otherwise mutate anything in the source channel.
- **Destination channel (`#escalations-review`) is for report output
  only**, and publishing is not implemented yet (a later milestone).
- **An explicit guard (`src/slack/safety.ts`) refuses to post** if the
  destination channel ID ever matches the source channel ID. The same
  invariant is also enforced at startup, in environment validation
  (`src/config/env.ts`) — the app will not even start if the two channel
  IDs are identical.
- **The Slack bot token is never logged or printed**, by this codebase, at
  any log level.
- **Fetched Slack data stays local and out of git.** `npm run slack:fetch`
  writes raw (but read-only-sourced) message/thread content to `data/slack/`
  as JSON. `data/` is git-ignored — this data may contain customer
  information and must never be committed. Nothing is sent to an LLM or
  embeddings API by this milestone; all processing is local.
- **A `conversations.replies` failure stops the fetch, it does not skip
  silently.** If Slack rejects the thread-replies call (e.g. missing scope,
  bot not in channel), `slack:fetch` prints the Slack error code, a
  plain-language explanation, and exits without writing a partial output
  file.
- **LLM extraction sends thread content to Anthropic's API, never to Slack.**
  `npm run intelligence:extract` never calls any Slack write method (there
  isn't one in this codebase) and never posts anywhere. The Anthropic API
  key is read only from the environment and is never logged or printed.
- **The LLM's structured output is de-identified; the raw source data is
  not.** The prompt instructs the model to keep customer names, emails,
  IDs, and other case-specific identifiers out of its structured output
  fields (`normalizedProblemStatement`, `resolutionSummary`, etc.) — but the
  raw thread text sent *to* the model, and stored in `data/slack/`, still
  contains whatever the original Slack messages contained. See "Privacy
  considerations" below.
- **The first real extraction run should be small.** `intelligence:extract`
  supports `--limit=N` and `--dry-run` specifically so a new dataset can be
  sanity-checked (and its payload size estimated) before spending real LLM
  calls on every thread.
- **Only de-identified problem statements are sent to the embedding
  provider.** `intelligence:embed` transmits *nothing* but
  `normalizedProblemStatement` values from items the LLM classified as
  genuine technical escalations. Raw Slack text, thread bodies,
  `suspectedRootCause`, `resolutionSummary`, `automationReasoning`, and every
  non-technical item are all excluded. A hard assertion
  (`assertEmbeddingCandidatesSafe`) re-verifies this immediately before the
  network call and aborts the run if anything ineligible reaches it.
- **The similarity report is fully local.** `intelligence:similarity` reads
  vectors off disk and computes cosine similarity in-process — no API key, no
  network call, and no LLM involved.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy the example environment file and fill in real values:

   ```bash
   cp .env.example .env.local
   ```

   `.env.local` is git-ignored — never commit real tokens.

3. Required environment variables (see `.env.example`):

   | Variable | Required | Default | Notes |
   |---|---|---|---|
   | `SLACK_BOT_TOKEN` | yes | — | Slack bot token (`xoxb-...`) |
   | `SLACK_SOURCE_CHANNEL_ID` | yes | — | `#escalations` — read only |
   | `SLACK_DEST_CHANNEL_ID` | yes | — | `#escalations-review` — report output only |
   | `SLACK_DAYS_BACK` | no | `30` | Trailing window for later fetch/analysis milestones |
   | `ANTHROPIC_API_KEY` | only for `intelligence:extract` | — | Never logged or printed |
   | `ANTHROPIC_MODEL` | no | `claude-haiku-4-5` | See "Model choice" below |
   | `VOYAGE_API_KEY` | only for `intelligence:embed` | — | Never logged or printed |
   | `VOYAGE_EMBEDDING_MODEL` | no | `voyage-4-large` | 1024-dim float vectors by default |
   | `RECURRENCE_CANDIDATE_SIMILARITY` | no | `0.60` | Candidate-generation floor **only** — not a "same issue" threshold |

   The app refuses to start if `SLACK_SOURCE_CHANNEL_ID` and
   `SLACK_DEST_CHANNEL_ID` are identical. `ANTHROPIC_API_KEY` is validated
   only when `intelligence:extract` actually needs it — `slack:probe` and
   `slack:fetch` work fine without it.

### Model choice

Default: **`claude-haiku-4-5`**, Anthropic's fastest and cheapest current
model. This milestone's task — deciding whether a Slack thread is a genuine
technical escalation and extracting a fixed set of structured fields — is a
classification/extraction task, not open-ended reasoning, and Haiku 4.5
fully supports Anthropic's structured-outputs feature (schema-constrained
JSON via Zod), so the model literally cannot return a shape that doesn't
match `EscalationAnalysis`. Set `ANTHROPIC_MODEL` to a Sonnet or Opus model
in `.env.local` if classification quality on your real data needs it — the
code has no model-specific logic, only the model ID changes.

### Embedding model choice

Default: **`voyage-4-large`**, matching the model the pipeline was validated
against, producing **1024-dimensional float vectors**. The default is kept in
sync with `.env.local` on purpose: embedding reuse is keyed on the model
name, so a mismatched default would silently produce vectors that aren't
comparable with existing ones. The pipeline never sends
`output_dimension`, so the model's own default applies and the actual
dimension returned is recorded in the output metadata and validated for
consistency across every vector. Voyage is called over its documented REST
endpoint using Node's built-in `fetch` — no SDK dependency was added.

`input_type` is deliberately **not** set. Passing `"query"` or `"document"`
prepends a retrieval-specific prompt designed for asymmetric query→document
matching; here we compare problem statements against each other
symmetrically, so the neutral default is the correct choice.

### Required Slack app scopes

Read access (probe, fetch):

- `channels:read`
- `channels:history`

Write access (publication only):

- `chat:write` — required by `intelligence:slack-publish`. Add it, then
  **reinstall the app to the workspace**. Application guards restrict every
  write to `C0DEST00000`; the source channel can never receive a post.

If either channel is **private** (the source channel is), use the group
equivalents instead:

- `groups:read`
- `groups:history`

Slack scopes `history` access per conversation type (public vs. private),
and that single scope covers both `conversations.history` and
`conversations.replies` for that type — so if `slack:probe` can already
read recent messages from a channel, `slack:fetch`'s use of
`conversations.replies` on the same channel is expected to work with the
same token. `slack:fetch` also calls `chat.getPermalink`, which only
retrieves a link to an existing message (it does not post or mutate
anything) and does not require `chat:write`.

The bot must also be a **member of both channels** (`/invite @YourBotName`
in each channel) — scopes alone aren't sufficient for a bot to read a
channel it hasn't joined.

When report publishing is implemented in a later milestone, `chat:write`
will be added — scoped to posting only, never used against the source
channel (see [PLAN.md](./PLAN.md) §11).

No workspace-wide or admin scopes are required or requested.

## Commands

```bash
npm run typecheck            # TypeScript, strict mode, no emit
npm test                     # Vitest — all Slack/Anthropic/Voyage calls mocked, zero real API calls
npm run slack:probe          # Read-only Slack connectivity probe (calls real Slack API)
npm run slack:fetch          # Fetch + persist escalation threads as JSON (calls real Slack API)
npm run intelligence:extract # LLM classification + extraction over fetched threads (calls real Anthropic API)
npm run intelligence:workflow-summary # Inspect captured manual workflows (fully local, no API calls)
npm run intelligence:workflow-embed      # Embed workflow statements (calls real Voyage API)
npm run intelligence:workflow-similarity # Workflow similarity distribution (fully local, no API calls)
npm run intelligence:workflow-adjudicate # LLM workflow recurrence adjudication (calls real Anthropic API)
npm run intelligence:workflow-clusters   # Aggregate SAME verdicts into clusters (fully local, no API calls)
npm run intelligence:workflow-recommend  # Rank automation opportunities (calls real Anthropic API)
npm run intelligence:embed      # Embed technical problem statements (calls real Voyage API)
npm run intelligence:similarity # Nearest-neighbour + top-pairs report (fully local, no API calls)
npm run intelligence:calibration-review # Human-review set for threshold calibration (fully local, no API calls)
npm run intelligence:review     # Build the leadership review from existing artifacts (fully local, no API calls)
npm run intelligence:adjudicate # LLM recurrence adjudication over candidate pairs (calls real Anthropic API)
npm run intelligence:groups     # Build recurring issue groups from SAME edges (fully local, no API calls)
npm run intelligence:report     # Rank and analyse recurring issues + manual workflows (fully local, no API calls)
npm run intelligence:recommend  # LLM engineering recommendation per recurring issue (calls real Anthropic API)
npm run intelligence:slack-preview # Render the Slack report locally (no Slack/LLM calls, posts nothing)
npm run intelligence:slack-publish # Validate a reviewed preview; posts ONLY with an explicit --publish flag
```

### Two tracks: technical issues and manual workflows

The pipeline tracks **two independent things**, because both are worth
automating and neither substitutes for the other:

| Track | What it captures | Files |
| --- | --- | --- |
| **A. Technical issue** | Genuine defects, errors, and broken behaviour | `embeddings-*`, `adjudications-*`, `groups-*` |
| **B. Manual operational workflow** | Repeatable manual tasks the technology team is asked to perform by hand — cancelling a policy, moving a program back to edit, reactivating a policy, updating a customer identity across systems | `workflow-embeddings-*`, `workflow-adjudications-*`, `workflow-groups-*` |

Extraction makes the two judgements **independently**, so all four
combinations are legitimate:

- defect only (a bug with no manual workaround),
- workflow only (an operational request that is not a defect),
- both (a defect whose standing workaround is a recurring manual fix),
- neither (a one-off question).

`--category=technical|workflow` selects the track on `intelligence:embed`,
`intelligence:adjudicate`, and `intelligence:groups`; it defaults to
`technical`, so every existing command keeps its current behaviour and
existing technical artifacts are untouched.

The two embedding pools are **never mixed** — a workflow statement and a
technical problem statement describe different things, and blending them
into one vector space would manufacture false neighbours.
`assertEmbeddingCandidatesSafe` refuses a mixed batch outright.

Recurrence is likewise counted separately. Workflow frequency is never added
to defect frequency; the report renders them as two sections built from two
different models.

```bash
# Track B, after a v3 extraction
npm run intelligence:embed -- --category=workflow --dry-run
npm run intelligence:embed -- --category=workflow

npm run intelligence:adjudicate -- --category=workflow --dry-run
npm run intelligence:adjudicate -- --category=workflow

npm run intelligence:groups -- --category=workflow

# The report picks up workflow-groups-*.json automatically
npm run intelligence:report -- --dry-run
```

> Extraction prompt **v3** added the workflow fields. `intelligence:embed`
> requires v3 and refuses older files rather than silently treating a v2
> extraction as having no workflows — re-run `intelligence:extract` to
> regenerate.

### 90-day pipeline (dry runs first)

Every step that costs money or touches production supports `--dry-run`,
which makes **zero** external API calls and writes nothing:

```bash
npm run slack:fetch -- --days=90 --dry-run
npm run slack:fetch -- --days=90

npm run intelligence:extract -- --input=data/slack/escalations-90d-<date>.json --dry-run
npm run intelligence:extract -- --input=data/slack/escalations-90d-<date>.json

npm run intelligence:embed -- --input=data/intelligence/extractions-90d-<date>.json --dry-run
npm run intelligence:embed -- --input=data/intelligence/extractions-90d-<date>.json

npm run intelligence:similarity -- --input=data/intelligence/embeddings-90d-<date>.json
```

### `npm run slack:probe`

Verifies the app can safely read `#escalations`:

1. Authenticates with `auth.test` and prints the workspace/bot identity.
2. Confirms both the source and destination channel IDs are accessible.
3. Fetches at most 5 recent top-level messages from the **source channel
   only**, printing safe metadata (timestamp, author ID, reply count, a
   truncated text preview) — not full message bodies.
4. Confirms source and destination channel IDs differ.
5. Never posts anything to Slack.

This command makes real Slack API calls (read-only) — it requires a valid
`SLACK_BOT_TOKEN` in `.env.local`.

### `npm run slack:fetch`

Fetches the last N days of messages/threads from the source channel and
writes them to `data/slack/escalations-<date>.json`:

```bash
npm run slack:fetch                 # uses SLACK_DAYS_BACK (default 30)
npm run slack:fetch -- --days=30
npm run slack:fetch -- --days=90
```

1. Fetches all top-level messages with `conversations.history`, paginating
   with Slack's cursor, bounded by the requested window's `oldest`
   timestamp — it never fetches messages older than necessary.
2. Filters out obvious Slack system/housekeeping events (channel joins,
   topic/purpose changes, pinned-item notices, etc.) by `subtype` — this is
   simple, non-semantic filtering; ordinary human messages are always kept,
   even ones that later turn out not to be real technical escalations.
3. For every remaining message with replies, fetches the full thread via
   `conversations.replies` (paginated) and retrieves a permalink via
   `chat.getPermalink`.
4. Assembles one `EscalationThread` (root message + replies + permalink)
   per retained message and writes them, plus run metadata, to
   `data/slack/escalations-<date>.json`.
5. Prints only aggregate counts to the terminal — never full message
   bodies, and never the bot token.
6. If Slack rejects `conversations.replies` (e.g. a missing scope or the
   bot not being a channel member), the command stops immediately, prints
   the Slack error code and a plain-language explanation, and does not
   write a partial output file.

This command makes real Slack API calls (read-only) — it requires a valid
`SLACK_BOT_TOKEN` in `.env.local`. It does not call any LLM or embeddings
API, and it never posts to Slack.

### `npm run intelligence:extract`

Analyses fetched escalation threads with Claude and writes structured
results to `data/intelligence/extractions-<date>.json`:

```bash
npm run intelligence:extract                                              # uses the newest data/slack/escalations-*.json file
npm run intelligence:extract -- --input=data/slack/escalations-2026-08-09.json
npm run intelligence:extract -- --limit=5                                 # analyse only the first 5 threads — use this for a first run
npm run intelligence:extract -- --dry-run                                 # preview counts and estimated payload size, zero API calls, no output written
```

1. Loads the input file (explicit `--input`, or the newest
   `data/slack/escalations-*.json` by filename).
2. For each thread: strips Jira-sync-bot noise (e.g. "created a Task
   ENG-1234...", "synced this thread with the Jira work item...") while
   keeping ordinary replies — including ones that happen to contain a Jira
   URL — then sends the root message + remaining replies to Claude.
3. Claude decides `isTechnicalEscalation` and, for genuine technical
   escalations, extracts a de-identified `normalizedProblemStatement` plus
   severity, customer impact, resolution status, and an automation-candidate
   assessment — see `src/llm/schemas/escalationAnalysis.ts` for the full
   schema. Root cause is only ever reported with the confidence the thread
   actually supports; the model is instructed never to invent one.
4. Structured outputs (Zod schema → JSON schema, validated by the SDK) mean
   a response either matches the schema or the extraction is recorded as
   failed — never a best-effort guess at the shape.
5. **Resumability:** if a thread's `rootTs` was already successfully
   analysed by a prior run using the same prompt version and model, it's
   reused instead of calling the LLM again — checked across every existing
   `data/intelligence/extractions-*.json` file.
6. **Retry:** a rate limit, 5xx, or network error is retried up to 3
   attempts total with exponential backoff; anything else (a bad request, a
   refusal, a schema mismatch) fails that thread immediately, is recorded as
   a failed extraction, and does not block the remaining threads.
7. Prints only classification labels and aggregate counts — never full
   Slack thread content, and never the Anthropic API key.

This command makes real Anthropic API calls (billed) — it requires
`ANTHROPIC_API_KEY` in `.env.local`. It never posts to Slack.

#### Enum normalization

Strict Zod validation is preserved end to end. Before that validation runs,
an enum value the schema would reject is rewritten onto the fallback the v3.1
prompt already documents:

| Field | Fallback |
| --- | --- |
| `classification` | `unclear` |
| `severity` | `null` (the schema's own nullable — never a guessed level) |
| `customerImpact` | `unknown` |
| `resolutionStatus` | `unclear` |
| `automationCandidate` | `unclear` |
| `workflowClassification` | `null` when `isAutomationWorkflowCandidate` is false; otherwise `other_operational_workflow` |
| `automationStatus` | `unknown` |

Normalization triggers on four conditions, each recorded as its own reason:
`value_not_in_enum`, `null_for_non_nullable_field`, `missing_field`, and
`non_string_value`.

Three properties hold by construction:

- **Every fallback is an explicit unknown** — `unclear`, `unknown`,
  `other_operational_workflow`, or `null`. An invalid value is never mapped
  onto a semantically specific category, because a wrong-but-specific value
  silently corrupts recurrence counts while an explicit unknown does not.
- **The wire schema is unchanged.** The JSON Schema sent to the API keeps its
  exact enum constraints, so the model is still grammar-constrained to the real
  vocabulary; normalization only handles what slips past it.
- **A valid response is returned untouched** — same object, no diagnostics.

Every rewrite is persisted on the result as `normalizations[]`, carrying the
field name, the raw value the model returned, the fallback applied, the reason,
and the allowed values. A normalized field is therefore always auditable and
never indistinguishable from a value the model actually chose:

```
⚠ 1 results had an invalid enum value rewritten onto a documented fallback
    1781861004.373189 — resolutionStatus: "partially_resolved" → "unclear" (value_not_in_enum)
```

#### Retrying only failed extractions

Structured-output validation is strict: if the model returns an enum value
that is not in the schema, that thread fails rather than being coerced into a
neighbouring category. Silently accepting an invented value would corrupt
every downstream count, so the failure is the correct behaviour — but the
other threads in the run should not be paid for twice.

```bash
npm run intelligence:extract -- \
  --input=data/slack/escalations-180d-2026-08-12.json \
  --retry-failed
```

This:

- loads the existing extraction output whose `metadata.inputFile` matches the
  input, taking the newest if several exist;
- re-analyses **only** the threads whose prior status was `failed`;
- preserves every prior success untouched and never re-sends it to Claude;
- merges repaired records back into their original positions by `rootTs`, so
  no duplicate result is ever appended;
- rewrites that same file in place.

Add `--dry-run` to see exactly which records would be retried, and why,
without making any API call. Failures are reported with the offending field:

```
✓ 293 successes preserved (not re-sent to Claude)
✓ 4 failed records to retry
    1780475763.777319 — invalid enum: resolutionStatus
    1776061159.203769 — invalid enum: workflowClassification
```

> **Prompt revision, not version.** The enum-discipline rules constrain output
> *formatting* only, and the later de-identification rewording changed example
> nouns rather than criteria — no classification rule changed — so the prompt
> stays at `v3` and is tracked as revision `v3.2` in `metadata.promptRevision`.
> Bumping to `v4` would invalidate every prior success, and
> `REQUIRED_EXTRACTION_PROMPT_VERSION` would reject the existing extraction
> files outright, forcing a full paid re-analysis for no analytical gain.

### `npm run intelligence:workflow-summary` — manual workflow inspection

Fully local; makes **zero** API calls. Intended for eyeballing the workflow
track before committing to embeddings.

```bash
npm run intelligence:workflow-summary -- \
  --input=data/intelligence/extractions-180d-2026-08-12.json
```

Prints the 2×2 breakdown, per-classification counts, and the most recent 20
`normalizedWorkflowStatement` values (`--limit=N` to change) with each
thread's `rootTs`, permalink, automation status, and whether it is
`technical+workflow` or `workflow-only`.

#### Extraction summary

The summary reports both dimensions independently, because a thread can be a
defect, a repeatable manual task, both, or neither:

```
Classification
✓ 120 technical escalations
✓ 173 non-technical

Workflow intelligence
✓ 139 automation workflow candidates
✓ 154 non-workflow threads
✓ 48 technical + workflow
✓ 91 workflow-only
✓ 72 technical-only
✓ 82 neither
  (buckets cover the 293 successful extractions; 4 failed)

Workflow types
  policy_state_change          25
  policy_cancellation          5
  ...
```

The four buckets sum to the number of **successful** extractions. A failed
extraction has no analysis and is deliberately excluded from every bucket
rather than being counted as "neither", which would understate how much
manual work the channel actually contains.

### `npm run intelligence:workflow-embed` — manual workflow embeddings

The workflow track's own vector pool. It embeds **only**
`normalizedWorkflowStatement` and never `normalizedProblemStatement`; the two
pools stay in separate files and are never combined.

```bash
npm run intelligence:workflow-embed -- \
  --input=data/intelligence/extractions-180d-2026-08-12.json --dry-run

npm run intelligence:workflow-embed -- \
  --input=data/intelligence/extractions-180d-2026-08-12.json
```

Selection: successful results where `isAutomationWorkflowCandidate === true`
**and** `normalizedWorkflowStatement` is non-null and non-empty. Supports
`--dry-run` and `--limit=N`.

Each record keeps `rootTs`, `permalink`, the statement, `workflowClassification`,
`automationStatus`, `isTechnicalEscalation`, `classification`, `affectedSystem`,
`resolutionStatus`, `automationCandidate`, a `nature` field
(`technical+workflow` / `workflow-only`), and the vector.

**What leaves the machine:** the de-identified statements, nothing else.
`assertWorkflowPayloadSafe` runs before any network call and rejects a
statement containing an email, Slack permalink, HubSpot URL, Stripe-style id,
UUID, Slack mention, or long numeric id. `rootTs` and `permalink` are local
metadata and are never transmitted.

**Resumability** is keyed on `rootTs + normalizedWorkflowStatement + model`, so
a reworded statement is re-embedded rather than silently reusing a stale
vector. A technical embedding can never satisfy a workflow lookup — the cache
only indexes files whose `embeddedField` is `normalizedWorkflowStatement`.

Output: `data/intelligence/workflow-embeddings-<window>-<date>.json`.

### `npm run intelligence:workflow-similarity` — local distribution analysis

Fully local; **zero** API calls.

```bash
npm run intelligence:workflow-similarity -- \
  --input=data/intelligence/workflow-embeddings-180d-2026-08-12.json
```

Reports every unique pair with max/median/mean, a distribution across eight
buckets (`>= 0.90` down to `< 0.60`), and the top 30 pairs with both
statements, classifications, automation statuses, and Slack permalinks. It
also splits the distribution by same-vs-cross `workflowClassification` without
filtering anything, as evidence for whether classification should constrain
candidate generation later.

> **No workflow floor is set.** The technical pipeline's 0.60 candidate floor is
> deliberately NOT reused here. Workflow statements are far more formulaic than
> defect descriptions, so the floor must be chosen from this measured
> distribution rather than inherited. The buckets are finer than the technical
> ones precisely because the interesting variation is expected to sit high in
> the range.

### `npm run intelligence:workflow-adjudicate` — workflow recurrence adjudication

```bash
npm run intelligence:workflow-adjudicate -- \
  --embeddings=data/intelligence/workflow-embeddings-180d-2026-08-13.json --dry-run

npm run intelligence:workflow-adjudicate -- \
  --embeddings=data/intelligence/workflow-embeddings-180d-2026-08-13.json
```

Supports `--dry-run`, `--limit=N`, and `--floor=N`.

**Candidate floor: 0.80**, chosen from the measured 142-vector distribution
(median 0.3177, mean 0.3392), which yields 136 candidate pairs from 10,011.
It is a candidate-generation floor, **not** a "same workflow" threshold — pairs
at 0.80 are routinely judged `different`.

**Cross-classification pairs are never filtered.** Calibration found genuine
same-workflow pairs crossing label boundaries — `account_data_update` ↔
`policy_state_change` for payment-state transitions, `policy_reactivation` ↔
`policy_state_change` — so 22 of the 136 candidates are cross-classification and
all are retained. The prompt states explicitly that `workflowClassification` is
weak evidence only and must never by itself decide the verdict.

Verdicts: `same_underlying_workflow`, `related_workflow_family`, `different`.
A `proposedWorkflowName` is kept only on `same_underlying_workflow`, enforced in
code rather than trusted from the prompt.

**What is sent to Claude:** the two `normalizedWorkflowStatement` values, both
`workflowClassification` and `automationStatus` values, both `nature` values,
and the cosine similarity. Nothing else. `toAdjudicationPayload` builds this by
explicit field projection rather than by deleting keys, so a field added to the
local record cannot leak by omission. `rootTs`, `permalink`, and vectors stay
local.

**Resumability** is keyed on `sorted(rootTsA, rootTsB) + promptVersion + model`,
so re-running with a larger `--limit` reuses prior verdicts exactly. Failures
are never cached.

#### Calibration sampling by similarity band

Adjudicating only the highest-similarity pairs validates nothing near the
floor — the first 30 pairs (0.8760–0.9712) all came back
`same_underlying_workflow`, which says more about where they sat than about the
adjudicator. `--min-similarity` and `--max-similarity` select a band instead:

```bash
# Inspect the bottom band locally — zero Claude calls
npm run intelligence:workflow-adjudicate -- \
  --embeddings=data/intelligence/workflow-embeddings-180d-2026-08-13.json \
  --min-similarity=0.80 --max-similarity=0.85 --inspect

# Adjudicate 20 pairs from that band
npm run intelligence:workflow-adjudicate -- \
  --embeddings=data/intelligence/workflow-embeddings-180d-2026-08-13.json \
  --min-similarity=0.80 --max-similarity=0.85 --limit=20
```

`min` is inclusive, `max` is exclusive, matching the reporting buckets. The
band is applied **before** `--limit`, so `--limit=20` inside a band gives the
top 20 of that band rather than the top 20 overall.

`--inspect` prints the selected pairs — similarity, both statements, both
classifications, both automation statuses, same/cross classification, and both
Slack permalinks, annotated with any cached verdict — then stops. It makes zero
API calls and writes nothing.

The 0.80 floor remains the safety rail: `--min-similarity` below it is rejected
unless `--floor` explicitly permits it, so sampling below the floor is always a
deliberate act.

Band selection never invalidates the cache, which is keyed on
`sorted(rootTsA, rootTsB) + promptVersion + model` and knows nothing about
bands. A verdict earned in one band is reused in any later run that includes
that pair.

Output: `data/intelligence/workflow-adjudications-<window>-<date>.json`.

### `npm run intelligence:workflow-clusters` — recurrence aggregation

Fully local; **zero** API calls, no LLM.

```bash
npm run intelligence:workflow-clusters -- \
  --extractions=data/intelligence/extractions-180d-2026-08-12.json \
  --adjudications=data/intelligence/workflow-adjudications-180d-2026-08-13.json
```

**Algorithm:** connected components over `same_underlying_workflow` edges only.
Deliberately NOT merged by `related_workflow_family` (kept as a cross-cluster
pointer — "same operational area" is explicitly not "same task"), by embedding
similarity (the 0.80 floor is candidate generation, not a verdict), or by
`workflowClassification` (calibration found identical tasks carrying different
labels). A `different` verdict never creates an edge.

**Cluster ids are deterministic**: `wf-<lexicographically smallest member
rootTs>`. No UUIDs. Union-find always keeps the smaller root, clusters sort by
size then id, and members sort within a cluster — so repeated runs on the same
inputs are byte-identical regardless of input ordering.

**Representative statement** is an existing `normalizedWorkflowStatement`,
never a generated summary: the member with the most SAME edges inside its
component, ties broken on lowest rootTs.

**Integrity checks** run before anything is written, and throw
`WorkflowClusterIntegrityError` rather than emitting a partial artifact:
every candidate in exactly one cluster, no rootTs in two clusters, no
clustered rootTs that is not a candidate, total members equal to candidate
count, and each `occurrenceCount` matching its member list. A SAME edge naming
a thread outside the candidate set is counted as `danglingSameEdges` and
reported, never silently dropped.

Output: `data/intelligence/workflow-clusters-<window>-<date>.json`.

### `npm run intelligence:workflow-recommend` — automation opportunity ranking

```bash
npm run intelligence:workflow-recommend -- \
  --input=data/intelligence/workflow-clusters-180d-2026-08-13.json --dry-run

npm run intelligence:workflow-recommend -- \
  --input=data/intelligence/workflow-clusters-180d-2026-08-13.json
```

Supports `--dry-run`, `--limit=N`, and `--extractions=<path>`.

Only recurring clusters (`occurrenceCount >= 2`) are ranked. Singletons are
summarised separately as a long tail and never compete for a rank.

**Scoring is deterministic and computed before the LLM is called:**

```
baseScore = 0.30*frequency + 0.25*manualBurden + 0.15*automationReadiness
          + 0.10*engineeringDependency + 0.10*customerImpact + 0.10*recency
```

Each factor is 0–100, so the score is too. The weights are round numbers
expressing an ordering of concerns, not values tuned against this dataset.
`scoringBreakdown` records every raw factor, its weight, its contribution, and
the formula itself, so any score can be audited from the artifact alone.

- **frequency** — saturating log curve on occurrence count, so it separates
  well at low counts without letting one huge cluster dominate.
- **manualBurden** — weighted mean over `automationStatusBreakdown`
  (manual 100, partially_automated 60, unknown 50, already_automated 10).
- **automationReadiness** — how amenable each workflow shape is to guarded
  tooling, minus a penalty per extra classification spanned.
- **engineeringDependency** — 50 baseline (it reached the engineering channel
  at all), plus code-level involvement and privileged-access share.
- **customerImpact** — from extraction records only. With no extraction file it
  is explicitly neutral (50), never inferred from the workflow text.
- **recency** — full marks within 14 days, decaying to zero at 180.

**The LLM cannot change the numbers.** Its output schema has no score and no
rank field, the payload it receives contains neither, and rank is assigned from
the deterministic sort position. `automationPriority` is qualitative and sits
*alongside* the score rather than reordering it.

**What is sent to Claude:** occurrence count, the de-identified workflow
statements, classification and automation-status breakdowns, nature counts,
span and recency in days, and the customer-impact breakdown. No permalinks, no
rootTs, no raw Slack text, no base score. Permalinks and member rootTs are
reattached locally after the response.

Output: `data/intelligence/workflow-recommendations-<window>-<date>.json`.

### `npm run intelligence:review` — 6-month review builder

Assembles existing artifacts into a leadership-facing review. Fully local:
**zero** external API calls, no LLM, no Slack.

```bash
npm run intelligence:review -- --window=180d --dry-run   # preview, writes nothing
npm run intelligence:review -- --window=180d             # writes the artifact
```

Explicit paths (`--extractions`, `--workflow-clusters`,
`--workflow-recommendations`, `--technical-report`) always override
auto-resolution, and auto-resolution only ever matches files tagged with the
requested window — a 90-day file cannot be picked up for a 180-day review.

Sections: overview, top automation opportunities, recurring manual workflows,
recurring technical issues, long tail, recommended next actions. Ranks, scores,
and recommendation text are copied verbatim from the recommendations artifact;
nothing is re-ranked or re-generated.

**Technical recurrence is optional.** When no report exists for the window, the
section says so explicitly and the workflow sections remain complete. A report
from a *different* window is rejected outright rather than silently presented
as if it matched.

Integrity checks (all fail loudly): every recommendation's cluster exists,
ranks unique and contiguous from 1, occurrence counts agree between
recommendations and clusters, evidence links belong to their own cluster, and
every input window matches the review window. `technical+workflow` threads are
counted once in `distinctActionableThreads`, never summed.

Output: `data/intelligence/review-<window>-<date>.json`, containing both the
structured data and rendered `plainText` / `slackMrkdwn` (overview message plus
four thread replies) ready for a future publisher.

### `npm run intelligence:embed`

Generates semantic embeddings for technical escalation statements and writes
them to `data/intelligence/embeddings-<date>.json`:

```bash
npm run intelligence:embed             # embed eligible statements
npm run intelligence:embed -- --dry-run # show counts, model, and batch plan; zero API calls, no file written
```

1. Reads the newest `data/intelligence/extractions-*.json` and **requires
   `promptVersion === "v2"`** — an older extraction file fails with a clear
   message telling you to re-run `intelligence:extract`.
2. Selects only results where `status === "success"`,
   `isTechnicalEscalation === true`, and `normalizedProblemStatement !== null`.
3. Asserts that every selected item satisfies those properties *again*,
   immediately before the network call — the run aborts and sends nothing if
   anything ineligible slipped through.
4. Sends the statements to Voyage **in batches** (default 128 per request, so
   the current dataset is a single call), then maps each returned vector back
   to its `rootTs` by sorting on the response's `index` field and verifying
   it forms a contiguous `0..n-1` range — an embedding can never be attached
   to the wrong escalation.
5. Validates that every vector shares one dimension before writing.
6. **Resumability:** if an embeddings file already exists for the same input
   file, extraction prompt version, and embedding model, it is reused and
   **zero API calls are made**. Change the model, or regenerate extractions
   under a new prompt version, and it regenerates. Delete the existing
   `embeddings-*.json` to force a fresh run.

### `npm run intelligence:similarity`

Reads the newest `data/intelligence/embeddings-*.json` and prints a
human-readable report, computed entirely locally:

```bash
npm run intelligence:similarity
```

- **Summary statistics**: total technical escalations, total unique pairs
  (`n*(n-1)/2`), and the maximum, median, and mean similarity.
- **Similarity distribution buckets** (`0.80–1.00`, `0.70–0.7999`,
  `0.60–0.6999`, `0.50–0.5999`, `0.40–0.4999`, `below 0.40`) with counts and
  percentages. These are **observation buckets only** — no bucket is labelled
  "same issue" and no threshold is selected.
- For each escalation, its **top 3 nearest other** escalations with cosine
  similarity scores (self is always excluded).
- The **top 25 most similar unique pairs** across the whole dataset, each
  with both statements, both `rootTs` values, and both Slack permalinks — so
  every candidate pair can be checked against the original threads.

No threshold is applied and no grouping is performed. The report explicitly
does not claim that any score means two items are the same issue; that
judgment is yours, informed by this evidence.

### `npm run intelligence:calibration-review` — threshold calibration workflow

Cosine similarity is useful for *discovering candidate* recurring issues, but
on real Upcover data it does not by itself decide whether two escalations are
the same underlying engineering issue. This command prepares evidence so that
decision can be made from human labels rather than guessed.

```bash
npm run intelligence:review                                                    # newest embeddings file
npm run intelligence:review -- --input=data/intelligence/embeddings-90d-<date>.json
npm run intelligence:review -- --per-bucket=20                                 # widen the sample
```

It writes `data/intelligence/reviews/similarity-review-90d-<date>.json`
containing a representative sample of candidate pairs drawn from six
calibration bands — `>= 0.80`, `0.75–0.7999`, `0.70–0.7499`, `0.65–0.6999`,
`0.60–0.6499`, and `below 0.60`. These bands are deliberately finer than the
similarity report's, because calibration needs resolution exactly where
"same issue" plausibly begins.

Sampling rules, so the review stays a manageable size without hiding evidence:

- Any bucket with fewer pairs than the per-bucket budget (default 12) is
  included **whole**.
- The `>= 0.80` bucket gets a larger allowance (50), so every
  very-high-similarity pair is reviewed whenever that number is manageable.
- Larger buckets are sampled at **even stride across the bucket's full range**
  — including its first and last pair — rather than taking the top slice.
- Sampling is **deterministic**: pairs are totally ordered by similarity then
  by `rootTs`, so running twice on the same embeddings produces an identical
  artifact. Unordered pairs are de-duplicated, so the same two escalations are
  never presented twice.

Each pair carries the similarity score, both normalized statements, both
`rootTs` values, both Slack permalinks, and two blank fields to fill in:

```json
{
  "pairId": "1754...::1755...",
  "bucket": ">= 0.80",
  "similarity": 0.8839,
  "a": { "rootTs": "...", "normalizedProblemStatement": "...", "permalink": "https://..." },
  "b": { "rootTs": "...", "normalizedProblemStatement": "...", "permalink": "https://..." },
  "sameUnderlyingIssue": null,
  "reviewerNotes": ""
}
```

Set `sameUnderlyingIssue` to `true`, `false`, or `"unsure"` and use
`reviewerNotes` for borderline calls. Label on the substance of the issue —
**not** by guessing where a cutoff should fall. The completed labels are the
input to choosing a recurrence threshold, which has deliberately **not** been
chosen or hard-coded anywhere in this codebase.

This command makes **zero** API calls (no Claude, Voyage, or Slack), performs
no clustering, and does not modify the existing embeddings or extractions —
enforced by tests that statically assert the review modules import no API
client and reference no network endpoint.

### `npm run intelligence:adjudicate` — LLM recurrence adjudication

Human calibration established that cosine similarity is good at *finding
candidates* but must not make the recurrence decision itself. This command
uses embeddings for cheap candidate discovery and then asks Claude to decide
the actual relationship between each candidate pair.

```bash
npm run intelligence:adjudicate -- --dry-run                      # candidates + cost estimate, zero API calls
npm run intelligence:adjudicate -- --limit=10                     # small first real run
npm run intelligence:adjudicate                                   # full run
npm run intelligence:adjudicate -- --floor=0.65                   # narrow the candidate set
npm run intelligence:adjudicate -- \
  --embeddings=data/intelligence/embeddings-90d-<date>.json \
  --extractions=data/intelligence/extractions-90d-<date>.json
```

**Candidate generation.** Only pairs at or above
`RECURRENCE_CANDIDATE_SIMILARITY` (default `0.60`, overridable with
`--floor`) are sent to Claude — on the 90-day dataset that is 58 pairs out of
2,415, which is where essentially all the cost saving comes from. **0.60 is
not a "same issue" threshold.** It only decides which pairs are worth
inspecting; the recurrence verdict is always the LLM's.

There is deliberately **no** `similarity >= 0.80 ⇒ SAME` shortcut. Every
candidate goes through the adjudicator uniformly, so its behaviour can be
evaluated across the whole candidate range rather than only where embeddings
were already confident.

**Relationship verdicts** — a three-way enum, not a boolean:

| Verdict | Meaning |
|---|---|
| `same_underlying_issue` | Different manifestations of the same underlying defect, limitation, or root problem. Fixing it once would plausibly resolve both. |
| `related_problem_family` | Same workflow/system/domain, but different technical problems or root causes. **Not** counted as repeats. |
| `different` | No meaningful recurring engineering relationship beyond broad domain overlap. |

The prompt is explicitly conservative: sharing a product area (payments,
renewals, dashboards, endorsements, quote generation, email, APIs) is *not*
sharing a defect. When torn between SAME and RELATED it must choose RELATED;
when torn between RELATED and DIFFERENT it picks the better-supported label
and lowers `confidence`.

**Root-cause evidence is decisive.** Each side is given its
`suspectedRootCause`, `rootCauseConfidence`, `affectedSystem`,
`issueTypeHint`, `resolutionStatus`, and `resolutionSummary`, joined back from
the extraction file by `rootTs`. Two escalations with materially different
established root causes generally must not be SAME even when the symptom is
identical — "payment link fails due to a fee mismatch" versus
"payment link fails due to an upstream API outage" is RELATED, not SAME. Absent
evidence is reported to the model as `(not established)` rather than omitted,
so it can't mistake a gap for agreement.

`proposedRecurringIssueName` is populated **only** for
`same_underlying_issue`. That invariant is enforced in code, not just asked
for in the prompt — a name on a RELATED or DIFFERENT pair would later be
mistaken for a cluster label.

**Resumability** is keyed on `pairId` + prompt version + model, so re-running
does not repay for completed adjudications; changing either the prompt version
or the model correctly forces re-adjudication.

Output: `data/intelligence/adjudications-90d-<date>.json`, retaining for each
pair the `pairId`, both `rootTs` values, both permalinks, both normalized
statements, cosine similarity, relationship, confidence, reasoning, and issue
name where applicable.

### `npm run intelligence:groups` — recurring issue group construction

Turns pairwise `SAME_UNDERLYING_ISSUE` verdicts into actual recurring
engineering issues. Fully local — no API calls, no LLM.

```bash
npm run intelligence:groups -- --dry-run    # build the graph and report, write nothing
npm run intelligence:groups
npm run intelligence:groups -- \
  --input=data/intelligence/adjudications-90d-<date>.json \
  --extractions=data/intelligence/extractions-90d-<date>.json
```

**The graph problem.** SAME verdicts form a graph, and transitivity does not
always hold. If A↔B and B↔C are SAME but A↔C is RELATED, naive connected
components would merge three escalations the adjudicator explicitly said are
not all the same issue.

**Algorithm: components first, cliques only on conflict.**

1. Build connected components over SAME edges only.
2. For each component, look up the verdict for *every* internal member pair.
3. **Nothing contradicts it** → emit the whole component as one group:
   - every pair explicitly SAME → `fully_confirmed`
   - some pair never adjudicated (it fell below the candidate floor, so it was
     never sent to the LLM) → `incomplete_pair_evidence`, flagged for review
     but **kept whole**
4. **An internal pair is explicitly RELATED or DIFFERENT** → the component is
   `conflicted`. Split it into maximal SAME-cliques (Bron–Kerbosch, sorted
   throughout so results are deterministic). Every emitted clique is
   `fully_confirmed` by construction. Overlapping membership is **reported,
   never silently merged**.

The distinction in steps 3 and 4 is the point: *missing* evidence and
*contradictory* evidence are not the same thing. Running maximal-clique over
everything would silently split a legitimately incomplete group into two
overlapping ones, discarding the signal that it is probably one issue with an
unadjudicated edge. Transitivity is never inferred over contradicting
evidence.

**Occurrence count** is the number of unique escalation threads, never the
number of pairwise edges — a 3-member group formed from 3 SAME edges counts
as 3 occurrences, not 3 relationships.

**Naming makes no LLM call.** The group takes the
`proposedRecurringIssueName` attached to its highest-confidence internal SAME
edge (ties broken by similarity, then pairId); all other proposals are kept in
`alternateNames`. No name is invented locally. An LLM consolidation pass can
come later.

**Dates** come from the Slack `rootTs` of each member, giving `firstSeen` and
`lastSeen`. An unparseable timestamp yields `null` rather than an invented
date.

**RELATED pairs never form groups.** Recurrence frequency is based on
`SAME_UNDERLYING_ISSUE` only; `relatedPairCount` is retained in metadata for
possible higher-level problem families later.

Output: `data/intelligence/groups-90d-<date>.json`.

### `npm run intelligence:report` — recurring issue analysis and ranking

Turns the groups file into a ranked, render-ready report model. Fully
deterministic and entirely local — no LLM, no API calls, and nothing is posted
anywhere.

```bash
npm run intelligence:report -- --dry-run   # print the report, write nothing
npm run intelligence:report
npm run intelligence:report -- --input=data/intelligence/groups-90d-<date>.json
```

**Per issue** it computes occurrence count, severity / customer-impact /
resolution-status distributions, first and last seen, recurrence span, average
gap between occurrences, days since last occurrence, distinct affected
systems, and a resolution posture (`unresolvedCount`, `workaroundCount`,
`openCount`, `hasOpenOccurrences`, `fullyResolved`).

Missing values become an explicit `unspecified` bucket rather than being
folded into an existing enum value — an extraction that never established a
severity is not the same as one judged "low", and conflating them would
overstate confidence. Empty buckets are retained so every distribution has the
same shape for renderers.

**Ranking is a tiered lexicographic ordering, not a weighted score:**

1. `occurrenceCount` desc — how often the issue actually recurred
2. `openCount` desc — occurrences still unresolved or on a workaround
3. `peakSeverityRank` desc
4. `peakCustomerImpactRank` desc
5. `lastSeenAt` desc
6. `groupId` asc — stable tie-break

A weighted composite would require inventing weights, and this project has
consistently calibrated such numbers against real labelled data rather than
guessing them. Automation-opportunity scoring is its own milestone
([PLAN.md](./PLAN.md) §10); this layer decides *presentation order* only.
Every signal used is emitted on each issue as `rankingSignals`, and the
criteria are written into the output as `rankingCriteria`, so the order can be
audited or re-derived differently without re-running anything upstream.

Output: `data/intelligence/report-90d-<date>.json`.

#### Section 2 — recurring manual operational workflows

Rendered only when a `workflow-groups-*.json` file exists (or is passed with
`--workflow-groups=<path>`). Each entry carries the workflow name, how many
times it was requested by hand, the first and last request, affected systems,
workflow types, automation status, and a Slack evidence link per occurrence.

Ranking is tiered, not a score:

1. request count, descending — how often a human is asked to do this by hand;
2. automation status — `manual` before `partially_automated` before
   `already_automated` before `unknown`;
3. recency — days since the last request, ascending;
4. group id, ascending (stable tie-break).

`automationStatus` is only ever `already_automated` when the thread says so.
A URL, endpoint, or tool name appearing in the conversation is **not**
evidence that the task is automated — an unrecognised or absent value becomes
`unknown`, never `manual`.

### `npm run intelligence:recommend` — engineering recommendations

Asks Claude what engineering should *do* about each already-confirmed
recurring issue.

```bash
npm run intelligence:recommend -- --dry-run    # counts and call estimate, zero API calls
npm run intelligence:recommend -- --limit=3    # small first real run
npm run intelligence:recommend                 # full run
npm run intelligence:recommend -- --input=data/intelligence/report-90d-<date>.json
npm run intelligence:recommend -- --model=claude-sonnet-5
```

**The LLM does not decide whether an issue recurs.** That was settled
deterministically upstream — embeddings, adjudication, then graph
construction. The prompt says so explicitly and instructs the model not to
revisit grouping. Its only job is to interpret the evidence inside a confirmed
group.

**One call per issue, never batched.** Independent calls keep each
recommendation uninfluenced by its neighbours, make retries and resumability
per-issue, and stop one bad response from discarding the rest of the run.

**Verdict fields:** `recommendedAction` (8-value enum from
`permanent_code_fix` through `documentation_or_training`), `priority`,
`engineeringRecommendation` (≤2 sentences), `rationale`, `evidenceSummary`
(≤2 sentences), `automationOpportunity`, `automationIdea`, and `confidence`.

**Automation opportunity is judged separately from priority**, because finding
work that could be automated away is the original point of the project. A
resolved calculation bug is `not_applicable` no matter how severe it was;
repeated manual state correction is `high` even if priority is medium.
`automationIdea` is forced to null for `not_applicable` — enforced in code, not
just requested in the prompt.

The prompt also forbids recommending a permanent code fix when the evidence
doesn't establish the mechanism; `investigate_root_cause` is the correct answer
there, not a failure to commit.

**Resumability** is keyed on `groupId` + prompt version + model, so re-running
doesn't repay for completed recommendations.

Output: `data/intelligence/recommendations-90d-<date>.json`, retaining each
issue's Slack permalinks for later rendering.

### `npm run intelligence:slack-preview` — Slack report rendering

Renders the exact messages that will eventually be posted to
`#escalations-review`, **locally only**. Nothing is sent anywhere.

```bash
npm run intelligence:slack-preview -- \
  --report=data/intelligence/report-90d-<date>.json \
  --recommendations=data/intelligence/recommendations-90d-<date>.json \
  --total-escalations=70
```

Joins the deterministic report to its recommendations by `groupId`, preserving
the report's ranking. The join fails loudly rather than degrading: a
recommendation for an unknown group means the two files came from different
runs, duplicate `groupId`s mean a corrupt input, and a successful
recommendation missing a required field would render as a blank section in a
report people act on. Issues whose recommendation *failed* upstream are
omitted and reported, not rendered empty.

**Message structure:** one overview message plus one detail message per
recurring issue — currently 8 messages. Splitting avoids a single unreadable
wall of text and keeps each message well under Slack's practical limit; the
CLI warns if any message exceeds 3,000 characters.

**Display names.** Persisted group names are written for precision and several
run past 15 words. `src/slackReport/displayNames.ts` maps them to short forms
("Record archival state sync failure" →
"Policy cancellation state sync"). Persisted names are never modified. The
fallback for an unmapped group is the **unchanged name**, not truncation —
cutting a sentence at N characters produces confident-looking nonsense, which
is worse in an actionable report than a name that is merely long. The CLI
warns when a group has no short form so new clusters get one deliberately.

**What is deliberately excluded from the rendered messages:** rationale,
cosine similarities, embedding details, the candidate floor, model names,
group IDs, and raw Slack content. Those stay in the internal JSON.

**`--total-escalations`** is optional. The report metadata does not currently
carry the total technical escalation count, so rather than invent or infer it
the overview simply omits that bullet unless the number is supplied.

Output: `data/intelligence/slack-preview-90d-<date>.json`, whose metadata
records the destination channel and `posted: false`.

**No Slack SDK is imported anywhere in this layer.** The renderer lives in
`src/slackReport/`, deliberately separate from `src/slack/` (which houses the
read-only API client), and tests statically assert that none of these files
reference `@slack/web-api`, `WebClient`, `chat.postMessage`, or `chat:write`.

### `npm run intelligence:slack-publish` — controlled publication

Posts an already-reviewed preview artifact to `#escalations-review`.
This is the only code in the project that writes to Slack.

**It fails closed.** The default invocation performs zero writes and acts as a
validation dry run. Only an explicit `--publish` flag enables posting; the flag
itself is the confirmation, so there is no interactive prompt.

```bash
# Safe validation — makes ZERO Slack API calls
npm run intelligence:slack-publish -- \
  --input=data/intelligence/slack-preview-90d-<date>.json

# First live test — posts ONLY the overview
npm run intelligence:slack-publish -- --publish --limit=1 \
  --input=data/intelligence/slack-preview-90d-<date>.json

# Full publication — overview + all issue replies
npm run intelligence:slack-publish -- --publish \
  --input=data/intelligence/slack-preview-90d-<date>.json
```

**One-time Slack setup.** Add the **`chat:write`** bot token scope to the
Slack app, then **reinstall the app to the workspace** (scope changes only
take effect on reinstall) and invite the bot to `#escalations-review`.
No other write scope is needed — not `chat:write.public`, `files:write`,
`reactions:write`, or any admin scope.

**Channel safety.** The destination is hard-coded as a constant in
`src/slackPublishing/safety.ts`, not merely configured. Before any write, all
of the following must hold or the run aborts: destination ≠ source,
destination === `C0DEST00000`, source === `C0SOURCE0000`, the preview artifact's
own destination matches configuration, and the preview is not already marked
posted. A second guard re-checks the channel immediately before *every*
individual post, so a future refactor that bypassed the run-level check would
still be stopped one call at a time. **There is no `--channel` flag** — passing
one is rejected outright rather than ignored, so nobody can believe they
redirected the output.

The read-only source client (`src/slack/client.ts`) is untouched and still
exposes no write methods; publication lives in a separate
`src/slackPublishing/` module. A test asserts the source client invokes no
write API.

**Threading.** The overview is posted as one top-level message; every issue
detail is posted as a reply carrying that message's `thread_ts`. A reply
without a `thread_ts` is refused, since it would silently become a second
top-level post and flood the channel.

**`--limit` counts total messages**, overview included: `--limit=1` posts only
the overview, `--limit=2` posts the overview plus the first issue, `--limit=8`
posts everything. A limit above the available count is capped.

**Partial failure.** If the overview fails there is no thread to reply into, so
the run stops immediately with status `failed` and nothing else is attempted.
If an individual reply fails, the run continues and records the failure — the
receipt captures exactly what landed, so nothing is republished blindly.

**Receipts and duplicate protection.** Every run writes
`data/intelligence/publications/slack-publication-90d-<date>-<runId>.json`
recording `overviewTs`, per-message `slackTs`, status, and failures.

Completeness is judged from the **union of successfully published message
indexes across every receipt** for that preview and channel, never from a
single run's `status`. That distinction matters: a successful `--limit=1` run
is `status: "completed"` — its own plan succeeded — but
`publicationCompleteForPreview: false`, because 7 messages remain. Receipts
written before these fields existed still work; completeness is recomputed from
published indexes, so no old receipt needs manual editing.

A preview whose every message has landed is refused, whether that happened in
one run or across a limited run plus resumes. A preview with outstanding
messages is also refused **unless** `--resume` is supplied — re-running it
plainly would repost the overview and start a second thread. There is
deliberately no `--force`.

**Resuming a partial publication.**

```bash
# Dry run — shows the outstanding messages, makes ZERO Slack calls
npm run intelligence:slack-publish -- --resume \
  --input=data/intelligence/slack-preview-90d-<date>.json

# Live resume — posts only what is missing, into the original thread
npm run intelligence:slack-publish -- --publish --resume \
  --input=data/intelligence/slack-preview-90d-<date>.json
```

Resume reads `overviewTs` from the existing receipts and replies into that same
thread. The overview is excluded from the plan by construction — already-landed
indexes are filtered out, and an explicit assertion aborts the run if an
overview ever appears in a resume plan. Adding `--limit` to a resume caps how
many of the *outstanding* messages to attempt, so replies can be added a few at
a time.

If a resume itself partially fails, the new receipt records exactly which
indexes succeeded, and a further `--resume` targets only what is still missing.
No index is ever posted twice.

**The reviewed preview is never mutated.** `posted` stays `false` in the
preview artifact; publication state lives only in the receipt. The message text
is posted byte-for-byte as reviewed — no renderer runs, no links are
regenerated, and no LLM or embedding call is made during publication.

## Privacy considerations

- **The prompt sent to Claude is not de-identified — only the model's
  output is.** Per the extraction schema design, Claude needs enough
  context (which may include customer names, emails, IDs, etc. from the raw
  Slack text) to understand the incident, but is instructed to keep all of
  that out of its structured output fields. This means real customer data
  is transmitted to Anthropic's API as input, subject to Anthropic's API
  data-handling/retention policy — confirm that policy meets your
  requirements before running this against real production data, and
  redact upstream first if it does not (see [PLAN.md](./PLAN.md) §11).
- **De-identification is prompt-enforced, not code-enforced.** Nothing in
  this codebase inspects `normalizedProblemStatement` etc. to verify no
  identifier slipped through — it relies on the LLM following instructions.
  Spot-check `data/intelligence/extractions-*.json` after a real run,
  especially before showing results to anyone outside the immediate team.
- **`data/intelligence/` is git-ignored**, same as `data/slack/` — never
  commit either directory.
- **What reaches Voyage is much narrower than what reaches Anthropic.**
  Anthropic receives raw thread text during *extraction* (needed to understand
  the incident); Voyage receives *only* de-identified
  `normalizedProblemStatement` strings for technical escalations. No raw Slack
  message, thread body, root cause, resolution summary, or non-technical item
  is ever sent to the embedding provider.
- **Adjudication sends no raw Slack data at all.** Unlike extraction, the
  adjudicator receives only the structured, de-identified extraction fields
  (normalized statement, classification, affected system, issue type hint,
  suspected root cause and its confidence, resolution status and summary).
  Raw thread text stays local.
- **Recommendation sends even less, and scrubs defensively.** The payload is
  aggregate statistics plus per-occurrence normalized statement, root cause,
  and resolution summary. Slack permalinks, `rootTs` values, channel ids, and
  raw thread text are excluded *by construction* — a test asserts the
  serialised payload contains none of them. Every free-text field is then run
  through `scrubIdentifiers()`, which redacts emails, vendor-style object ids
  (`cus_…`), UUIDs, and long digit runs before the call. Redaction is preferred
  over throwing so one false positive can't block a run, and the count is
  reported in the terminal and in output metadata — a non-zero count is a
  signal that identifiers are reaching extraction output and worth chasing
  upstream.

## Project structure

```
src/
  config/
    env.ts               # Zod schema + pure parseEnv() (unit-testable, no I/O); requireAnthropicApiKey()
    loadEnv.ts            # Loads .env.local, then validates process.env
  slack/
    client.ts             # Read-only Slack client wrapper — no write methods exist
    safety.ts             # assertSafePostTarget() — refuses source === destination
    connectivity.ts       # Probe logic: auth check, channel checks, message fetch
    filters.ts            # isSystemNoiseMessage() — subtype-based Slack system-event filter
    escalationThreads.ts  # Pagination, thread assembly, EscalationThread type
  llm/
    schemas/
      escalationAnalysis.ts   # Zod schema for structured extraction + EscalationAnalysis type
    prompts/
      escalationExtraction.ts # Versioned system/user prompt (ESCALATION_EXTRACTION_PROMPT_VERSION)
    preprocessThread.ts        # Jira-sync-bot noise filtering + thread-to-prompt-text
    retry.ts                    # Bounded retry/backoff for rate limits and transient errors
    extractEscalation.ts        # Core extraction logic — decoupled from the SDK for testability
    anthropicParseClient.ts     # Real @anthropic-ai/sdk wiring (messages.parse + zodOutputFormat)
    runExtraction.ts            # Orchestration: file picking, batching, resumability, metadata
  embeddings/
    selectCandidates.ts    # Technical-only filtering, v2 version check, pre-call safety assertion
    voyageClient.ts        # Voyage REST client (native fetch) + response ordering validation
    batching.ts            # chunk() / countBatches()
    runEmbedding.ts        # Orchestration: dry-run plan, batched embedding, dimension validation
    cosineSimilarity.ts    # Pure cosine similarity + dimension consistency check
    nearestNeighbours.ts   # All pairs, top-N neighbours per item, top unique pairs
    similarityStats.ts     # Distribution buckets + max/median/mean summary stats
  review/
    selectReviewPairs.ts   # Calibration bands + deterministic stride sampling + pair dedupe
  adjudication/
    candidatePairs.ts      # Similarity floor + rootTs join to extraction evidence
    adjudicatePair.ts      # Single-pair LLM adjudication (retry + issue-name invariant)
    runAdjudication.ts     # Orchestration: resumability, per-pair failure isolation, progress
  groups/
    relationshipMatrix.ts  # Pure relationship(A,B) lookup + per-group consistency report
    graph.ts               # Adjacency, connected components, Bron–Kerbosch, overlap detection
    buildGroups.ts         # Components-first grouping, conflict splitting, naming, aggregation
  slackReport/             # Slack mrkdwn rendering — imports no Slack SDK
    displayNames.ts        # Persisted-name → short display-name map, unchanged-name fallback
    formatters.ts          # Priority/status/automation/confidence/date/link formatting
    renderPreview.ts       # groupId join validation + overview and per-issue messages
  slackPublishing/         # The ONLY code that writes to Slack
    safety.ts              # Hard-locked destination + forbidden source; run and per-write guards
    client.ts              # Guarded chat.postMessage wrapper (no other write method exists)
    retry.ts               # Bounded Slack retry: rate limits and 5xx only, honours Retry-After
    publishPlan.ts         # Ordered plan, --limit semantics, and resume plan (excludes landed indexes)
    runPublication.ts      # Threaded posting, partial-failure isolation, receipt assembly
  recommendations/
    scrubIdentifiers.ts    # Defensive identifier redaction before any outbound payload
    buildPayload.ts        # De-identified per-issue evidence payload (no permalinks/rootTs)
    recommendIssue.ts      # Single-issue LLM recommendation (retry + automation-idea invariant)
    runRecommendations.ts  # One call per issue, resumability, per-issue failure isolation
  report/
    distributions.ts       # Canonical buckets, unspecified handling, distribution counting
    analyzeGroup.ts        # Per-issue metrics: distributions, recurrence window, resolution posture
    rankGroups.ts          # Deterministic tiered ordering + exposed ranking signals
    buildReport.ts         # Report model assembly + cross-issue summary
  persistence/
    datedFiles.ts         # Window-tagged `<prefix>[-<window>]-YYYY-MM-DD.json` build/parse/pick
    resolveInput.ts       # Shared --input resolution + auto-selection ambiguity warnings
    fetchOutput.ts        # JSON output shape + write-to-disk for slack:fetch
    extractionOutput.ts   # JSON output shape, write-to-disk, and resumability index for intelligence:extract
    embeddingOutput.ts    # JSON output shape, write-to-disk, and reuse lookup for intelligence:embed
    reviewOutput.ts       # Review artifact shape (blank human-label fields) + writer
    adjudicationOutput.ts # Adjudication output shape, writer, and resumability index
    groupOutput.ts        # Recurring issue group output shape + writer
    reportOutput.ts       # Ranked report output shape + writer
    recommendationOutput.ts # Recommendation output shape, writer, counts, resumability index
    slackPreviewOutput.ts   # Slack preview artifact shape + writer (posted: false)
    publicationReceipt.ts   # Receipt shape, writer, published-index union, resume state analysis
  cli/
    slack-probe.ts        # Entry point for `npm run slack:probe`
    slack-fetch.ts         # Entry point for `npm run slack:fetch`
    args.ts                # --days / --dry-run CLI arg parsing
    extractArgs.ts          # --input / --limit / --dry-run CLI arg parsing
    intelligence-extract.ts # Entry point for `npm run intelligence:extract`
    embedArgs.ts             # --input / --dry-run CLI arg parsing
    intelligence-embed.ts    # Entry point for `npm run intelligence:embed`
    similarityArgs.ts         # --input CLI arg parsing
    intelligence-similarity.ts # Entry point for `npm run intelligence:similarity`
    reviewArgs.ts              # --input / --per-bucket CLI arg parsing
    intelligence-review.ts     # Entry point for `npm run intelligence:review`
    adjudicateArgs.ts           # --embeddings / --extractions / --limit / --floor / --dry-run
    intelligence-adjudicate.ts  # Entry point for `npm run intelligence:adjudicate`
    groupsArgs.ts               # --input / --extractions / --dry-run
    intelligence-groups.ts      # Entry point for `npm run intelligence:groups`
    reportArgs.ts               # --input / --dry-run
    intelligence-report.ts      # Entry point for `npm run intelligence:report`
    recommendArgs.ts            # --input / --limit / --model / --dry-run
    intelligence-recommend.ts   # Entry point for `npm run intelligence:recommend`
    slackPreviewArgs.ts         # --report / --recommendations / --total-escalations
    intelligence-slack-preview.ts # Entry point for `npm run intelligence:slack-preview`
    slackPublishArgs.ts         # --input / --publish / --resume / --limit (rejects --channel)
    intelligence-slack-publish.ts # Entry point for `npm run intelligence:slack-publish`
tests/
  env.test.ts
  safety.test.ts
  connectivity.test.ts
  escalationThreads.test.ts
  filters.test.ts
  args.test.ts
  fetchOutput.test.ts
  llm/
    preprocessThread.test.ts
    escalationAnalysisSchema.test.ts
    extractEscalation.test.ts
    runExtraction.test.ts
  embeddings/
    cosineSimilarity.test.ts
    selectCandidates.test.ts
    batching.test.ts
    voyageClient.test.ts
    runEmbedding.test.ts
    nearestNeighbours.test.ts
  extractArgs.test.ts
  extractionOutput.test.ts
  embedArgs.test.ts
  embeddingOutput.test.ts
  datedFiles.test.ts

data/
  slack/                  # git-ignored — fetched Slack data, never commit
  intelligence/           # git-ignored — extractions + embeddings, never commit
    reviews/              # git-ignored — human-review artifacts for threshold calibration
```
