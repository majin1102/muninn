# Session Recall Mode Design

## Goal

Muninn should support session-level recall as a first-class retrieval mode.
The `muninn-import` Codex skill needs to find prior sessions by topic, then let
the user choose which sessions to read. It should not depend on fine-grained
`extraction` hits because those can be noisy when a query matches many local
semantic details inside otherwise unrelated sessions.

The MVP adds a `session` retrieval table and a recall mode split:

```ts
recall(query, limit, { mode: 'session' })
recall(query, limit, { mode: 'extraction' })
```

`mode` is the recall layer. There is no public `searchMode` option in this
design. Both modes use hybrid retrieval internally.

## Current Context

Current app recall search uses extraction hits and groups them by session.
That is useful for finding exact facts, but it is the wrong first-stage entry
point for importing prior context by session topic.

Existing storage concepts:

- `turn`: raw captured provenance and source content.
- `session_snapshot`: append-only session state snapshots produced by the extractor.
- `extraction`: fine-grained retrieval rows produced from session snapshots.
- `observation`: existing curation-related rows. This design does not add a public
  observation recall mode and does not route `muninn-import` through observations.

The new `session` table sits beside `extraction` as a retrieval table. It does
not replace `session_snapshot`.

## Retrieval Tables

`session_snapshot` remains the historical session state table.

`session` is a materialized retrieval table:

- One row per current captured session with live turns.
- The row represents the latest session topic.
- The row is updated from the latest session snapshot before extraction rows are
  written for that snapshot.
- The row can be regenerated from live turns plus latest session snapshots if
  the table is stale or the retrieval schema changes.

`extraction` remains the fine-grained retrieval table:

- One row per memory unit.
- Used for exact facts, decisions, preferences, and other detailed recall.

## Session Row Shape

MVP `SessionRow`:

```ts
type SessionRow = {
  latestSnapshotId: string;
  sessionId: string;
  project: string;
  cwd: string;
  agent: string;
  title: string;
  summary: string;
  searchText: string;
  vector: number[];
  updatedAt: string;
};
```

The table does not store a separate `id`, `sessionKey`, `references`, or
`createdAt`.

- `sessionKey` is derived from `{ project, agent, sessionId }`.
- `memoryId` is derived at the API layer from the same identity.
- MCP `context_id` stays an opaque `session_*` handle derived at the MCP layer
  from the same identity.
- `references` are read from `latestSnapshotId` only when a caller needs
  provenance or expansion.
- `updatedAt` is enough for recency display and tie-breaking.

`cwd` is display/latest-location metadata. It is not part of session identity.

## Session Text Fields

Session mode uses separate text for dense and lexical retrieval.

Vector text:

```text
title

summary
```

`vector` is the embedding of the vector text. It stays strictly session-topic
level so semantic search is not dominated by fine-grained extraction details.

FTS text:

```text
title
summary
extraction titles
extraction summaries
```

`searchText` is capped at 16,000 characters after concatenation. There is no
per-extraction truncation. Concatenation order preserves the most important
session-level text first:

1. Session title.
2. Session summary.
3. Extraction titles.
4. Extraction summaries.

The FTS side can match exact filenames, APIs, classes, modules, and terms that
may only appear in extraction titles or summaries. Extraction content and
context are not included in `searchText` for the MVP.

The extraction titles and summaries used for `searchText` come from the latest
parsed session snapshot content. They are not read from the `extraction`
retrieval table. This keeps session row materialization independent from the
later extraction table update.

## Write Path

The extractor write flow becomes:

```text
turns captured
-> extractor updates session thread
-> writes session_snapshot
-> upserts session retrieval row from latest snapshot
-> upserts/deletes extraction retrieval rows
```

The session retrieval row is written before extraction rows because it depends
only on the latest session snapshot. If extraction row updates fail after the
session row is written, the session-level topic entry remains useful and the
epoch can retry the extraction work.

If the session retrieval row cannot be written, the extractor epoch should fail
and retry. Session rows are part of the retrieval surface, not an optional UI
cache.

## Recall API

Recall exposes two public modes:

```ts
type RecallRequest = {
  query: string;
  database?: string;
  mode?: 'session' | 'extraction';
  limit?: number;
  budget?: number;
  queryLimit?: number;
  thinkingRatio?: number;
};
```

The existing public `recallMode?: 'vector' | 'fts' | 'hybrid'` request field is
removed. The recall API no longer exposes retrieval algorithm selection.

`mode` defaults to `extraction` for general recall endpoints. Callers that want
session-level candidate recall must pass `mode: 'session'` explicitly. The
`muninn-list` MCP tool always does this internally.

This design only removes the public retrieval-algorithm selector. It does not
remove existing extraction-mode synthesis controls such as `budget`,
`queryLimit`, or `thinkingRatio`. Those controls are valid only for
`mode: 'extraction'`. Session mode returns session candidates and should reject
`budget`, `queryLimit`, and `thinkingRatio` rather than silently treating them
as session-ranking controls.

Session mode:

- Searches the `session` table.
- Uses hybrid retrieval internally.
- Returns pure session candidates.
- Does not include top evidence snippets in the initial result.
- Is the mode used by the `muninn-import` Codex skill.

Extraction mode:

- Searches the `extraction` table.
- Uses hybrid retrieval internally.
- Preserves the current fine-grained recall use case.
- Remains the mode used by existing app search for now.
- Does not route through `observation` rows. Observation recall is a separate
  cleanup topic outside this design.

This design intentionally does not expose `vector`, `fts`, or `hybrid` as a
public recall option. Those are internal retrieval details.

## MCP And Codex Import Skill

The `muninn-import` Codex skill should use session mode:

```text
muninn-list({ query, top_k })
-> recall(query, top_k, { mode: 'session' })
-> numbered session candidates
-> user chooses candidates
-> muninn-read({ context_ids })
```

`muninn-list` returns candidates with a `session_*` `context_id`, following the
existing MCP context id contract. The MCP adapter maps that opaque handle to
the session recall identity or memory id internally. The core table does not
store a separate context id. MCP results must not expose internal session
`memoryId` values as `context_id` values.

`muninn-read` resolves those `session_*` ids to the selected sessions and reads the
corresponding session context. If the user asks for provenance behind a
candidate, `muninn-explain` can resolve the same session id through the latest
snapshot references.

## App Search

The existing app search should remain extraction-based in the MVP. The recall
page in the app currently serves fine-grained memory search better than session
import. Moving it to session mode is outside this design.

## Rebuild And Maintenance

The normal path is single-session upsert after a new session snapshot.

A full rebuild is a repair path, not the steady-state path. Rebuild can be used
when the session table is missing, stale, or has an incompatible retrieval
fingerprint. Examples:

- The embedding model or dimensions changed.
- The session retrieval schema changed.
- The `searchText` construction changed.
- The session table became inconsistent with live turns.

Rebuild scans live sessions from turns, picks the latest snapshot per
`{ project, agent, sessionId }`, and rewrites session retrieval rows from those
snapshots. Deleted sessions or projects should not reappear from old append-only
snapshots.

## Error Handling

- Empty queries return no hits.
- When supplied, `mode` must be either `session` or `extraction`.
- Missing `mode` defaults to `extraction`.
- Session mode rejects `budget`, `queryLimit`, and `thinkingRatio`.
- Session rows with both `title` and `summary` empty should not be indexed.
- Session row write failures fail the extractor epoch and are retried.
- Extraction row failures after a session row write remain retryable through the
  existing extraction write path.
- Unknown session `memoryId` / `session_*` context id values return a normal not-found
  response from read/explain paths.

## Testing

Core storage/native tests:

- Can upsert, get, delete, and search session rows.
- Session search uses hybrid retrieval.
- Session search returns latest session rows, not historical snapshots.
- Session search derives identity from `{ project, agent, sessionId }`.
- `searchText` includes title, summary, extraction titles, and extraction
  summaries, then caps at 16,000 characters.
- `vector` is built from title plus summary only.

Pipeline tests:

- Writing a session snapshot upserts the session retrieval row before extraction
  rows are written.
- Session row upsert failure fails the extractor epoch.
- Extraction row failure after session row upsert does not remove the session row.
- Deleting an imported session or project removes matching session retrieval rows.

Recall tests:

- `mode: 'session'` searches the session table and returns session candidates.
- `mode: 'extraction'` searches extraction rows and does not search sessions.
- Missing `mode` uses extraction mode.
- Session mode rejects extraction-only synthesis controls.
- Invalid recall modes fail validation.
- Empty queries return no hits for both modes.

MCP / skill-facing tests:

- Public recall requests accept `mode` and no longer accept `recallMode`.
- `muninn-list` calls session recall and returns `session_*` candidate context ids.
- `muninn-read` resolves selected `session_*` context ids.
- `muninn-import` does not call extraction mode for candidate listing.
- `muninn-explain` can resolve session candidate provenance through latest
  snapshot references.

## Non-Goals

- No app search mode switch in this MVP.
- No public `searchMode` option.
- No observation recall mode.
- No new compatibility layer for historical API shapes.
- No storage of duplicate `id`, `sessionKey`, `references`, or `createdAt`
  columns in the session retrieval row.
