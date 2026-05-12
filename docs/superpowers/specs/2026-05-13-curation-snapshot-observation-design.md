# Curation Snapshot And Observation Design

## Purpose

Muninn now has a first-layer memory path:

```text
turn -> session_snapshot -> extraction
```

`extraction` is still a session-level derivation. It is useful, but it is not the final curated memory layer. The next layer should organize related extractions into curated documents and derive thin recall rows from those documents:

```text
turn -> session_snapshot -> extraction -> curation_snapshot -> observation
```

This design only covers the curation data model, Markdown parsing rules, and write boundary. It does not implement automatic scheduling, checkpoint recovery, UI, or recall merging.

## Naming

- `session_snapshot`: append-only snapshots of session-level memory documents.
- `extraction`: session-level derived memory units.
- `curation_snapshot`: append-only snapshots of curated memory documents.
- `observation`: thin searchable rows derived from the latest curation snapshot.

Snapshot layers use row-id memory ids:

- `turn:<rowid>`
- `session:<rowid>`
- `curation:<rowid>`

Derived index layers use stable ids:

- `extraction:<stable-id>`
- `observation:<stable-id>`

This keeps append-only snapshots traceable by physical row id while allowing derived rows to be replaced by logical content identity.

## Curation Snapshot Table

`curation_snapshot` is the authoritative curated document table. It is append-only and mirrors the role of `session_snapshot`.

Fields:

- `snapshot_id`: memory id assigned from the Lance row id, formatted as `curation:<rowid>`.
- `curation_id`: stable logical id for the curated document, such as `entity:caroline`.
- `snapshot_sequence`: monotonic sequence per `curation_id`.
- `created_at`: snapshot creation timestamp.
- `updated_at`: snapshot update timestamp.
- `observer`: observer name that produced the snapshot.
- `anchor`: the main curation anchor, for MVP an Entity anchor such as `Caroline`.
- `title`: parsed document title.
- `summary`: short summary for list/detail display.
- `content`: full curated Markdown document.
- `references`: extraction ids covered by this snapshot, formatted as `extraction:<id>`.

MVP only supports Entity-anchor curation. `curation_id` is:

```text
entity:<normalized anchor>
```

Normalization trims, lowercases, and collapses whitespace. It does not solve same-name entity collisions in this version.

## Observation Table

`observation` is a thin index table. It is not the authoritative curated memory document. The authoritative text remains in `curation_snapshot.content`.

Fields:

- `id`: stable observation id.
- `curation_id`: logical curated document id.
- `snapshot_id`: curation snapshot memory id that produced this row.
- `text`: searchable text derived from a curated section.
- `vector`: embedding vector for `text`.
- `references`: extraction ids that support this observation.
- `created_at`: row creation timestamp.

No `anchor`, `title`, or `context` fields are required for MVP. Section headings and body text are folded into `text` so the index row stays thin while retaining retrieval signal.

## Curated Markdown

The existing `thread-curating.yaml` shape remains the base format:

```md
# Entity Memory: Caroline

## Who is Caroline?
<refs: [extraction:a, extraction:b]>

Caroline is ...

### What changed recently?
<refs: [extraction:b]>

Caroline recently ...
```

Rules:

- The document must have exactly one `#` title.
- `##` headings are broad retrieval questions and parent scopes.
- `###` headings are narrower questions under the nearest preceding `##`.
- `###` sections cannot appear before any `##`.
- Every `##` and `###` heading must be followed by `<refs: [...]>`.
- refs must be non-empty and must belong to the current extraction allowlist.
- refs must use `extraction:<id>`.
- section body text must be non-empty.
- headings deeper than `###` are not supported.

## Observation Derivation

Each `##` section can derive one observation.

Text:

```text
<## heading>

<section body>
```

References:

```text
refs from the ## heading
```

Each `###` section can also derive one observation, but it must carry its parent scope.

Text:

```text
<parent ## heading>
<child ### heading>

<child body>
```

References:

```text
dedup(parent ## refs + child ### refs)
```

This makes child observations retrievable without losing the broad question that gives them meaning.

## Write Flow

For one curation anchor:

1. Select extraction rows for that Entity anchor.
2. Render extraction inputs for `thread-curating.yaml`.
3. Generate curated Markdown.
4. Parse and validate the Markdown.
5. Build observation rows and embeddings in memory.
6. Append a new `curation_snapshot`.
7. Replace `observation` rows for the same `curation_id` with the newly derived rows.

The preferred ordering is parse and embed before writing the snapshot. That avoids a snapshot being persisted when its derived observation rows cannot be produced.

## Replacement Semantics

`curation_snapshot` is historical and append-only.

`observation` represents only the latest curation snapshot for a `curation_id`.

When a new curation snapshot is committed:

- Delete existing observation rows for the same `curation_id`.
- Insert the new derived observation rows.
- Do not keep old observation rows for recall, because that would duplicate stale curated memory.

The old curation snapshots remain available for traceability.

## Failure Handling

- If LLM output cannot be parsed, write nothing.
- If refs are invalid or outside the allowlist, write nothing.
- If embedding any derived observation fails, write nothing.
- If snapshot append succeeds but observation replacement fails, the runner should report failure. MVP recovery is rerunning curation for the same anchor, producing a newer snapshot and replacing observations.

This is acceptable for MVP because automatic scheduling and checkpointed curation recovery are out of scope.

## Out Of Scope

- Automatic curation trigger.
- Checkpoint recovery for curation.
- Recall merge between `observation` and `extraction`.
- UI for curation snapshots.
- Non-Entity anchor curation.
- Same-name entity disambiguation.
- Migration of old experiment data.

## Testing

Unit tests should cover:

- `curation_snapshot` schema and append behavior.
- `observation` schema and replace-by-`curation_id` behavior.
- Markdown parser success and failure cases.
- `###` deriving text and refs with its parent `##`.
- unknown extraction refs fail validation.
- stable observation id generation.
- Native and TypeScript binding shape.

Build verification should include:

- `cargo test` in `format/`.
- `pnpm --filter @muninn/core build`.
- focused core parser/native tests.
