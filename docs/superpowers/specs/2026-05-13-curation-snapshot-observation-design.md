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

This design covers the curation data model, trigger semantics, checkpoint recovery model, Markdown parsing rules, and write boundary. It does not cover UI or recall merging.

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

## Trigger And Incremental Curation

MVP curation is driven by extraction anchors. Only Entity anchors are eligible in this version.

Configuration:

- `curation.anchorThreshold?: number`
- default: `5`
- must be a positive integer

Trigger rules:

- Count current extraction rows that contain the same Entity anchor.
- If no curation exists for that anchor and the count is at least `anchorThreshold`, create the first curation snapshot.
- If curation already exists for that anchor, compare current anchor extraction ids with the latest `curation_snapshot.references`.
- If there are new or updated extraction ids not covered by the latest snapshot, run incremental curation.

Incremental curation input:

- `anchor`
- `content`: latest `curation_snapshot.content`, or empty text for the first run
- `extractions`: pending extraction rows not covered by the latest snapshot
- related covered extraction rows when needed to keep the prompt grounded

The curator still returns a complete curated Markdown document, not a patch. A new `curation_snapshot` is appended every time curation runs.

Extraction updates are handled by id semantics. If an extraction update changes the stable extraction id, the new id is treated as pending for the relevant anchor.

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

MVP only supports Entity-anchor curation. `curation_id` identifies the logical curated document for an anchor:

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

1. Select current extraction rows for that Entity anchor.
2. Decide whether the anchor needs initial or incremental curation.
3. Start or resume a checkpointed curation run.
4. Render extraction inputs for `thread-curating.yaml`.
5. Generate curated Markdown, or reuse checkpointed generated content.
6. Parse and validate the Markdown.
7. Build observation rows and embeddings in memory.
8. Append a new `curation_snapshot`.
9. Replace `observation` rows for the same `curation_id` with the newly derived rows.

The preferred ordering is parse and embed before writing the snapshot. That avoids a snapshot being persisted when its derived observation rows cannot be produced.

## Checkpoint Recovery

Curation is part of the memory write path and must be checkpointed. Runtime progress belongs in the existing observer checkpoint file, not in the data tables.

Add checkpointed `curationRuns` alongside observing runs.

```ts
type CurationRun = {
  runId: string;
  curationId: string;
  anchor: string;
  stage:
    | "selectingExtractions"
    | "generatingCuration"
    | "committingSnapshot"
    | "committingObservations"
    | "completed"
    | "failed";
  pendingExtractionIds: string[];
  generatedContent?: string;
  parsedObservationDrafts?: Array<{
    id: string;
    text: string;
    references: string[];
  }>;
  committedSnapshotId?: string;
  committedObservationIds?: string[];
  errors: Array<{
    message: string;
    stage: string;
  }>;
};
```

Recovery rules:

- selected extractions but no generated content: regenerate curation from the checkpointed extraction ids.
- generated content but no snapshot: parse, embed, and continue without calling the LLM again.
- snapshot committed but observations not committed: replace observations using `committedSnapshotId` and parsed drafts.
- observations committed: mark the run completed.
- parse or validation failure: mark the run failed and write no data table rows for that failed output.

This keeps tables as clean data-plane storage while checkpoint handles incomplete in-flight memory work.

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
- If snapshot append succeeds but observation replacement fails, checkpoint recovery resumes from `committedSnapshotId`.
- If observation replacement succeeds but completion is not checkpointed, recovery detects `committedObservationIds` or reloads latest rows and marks the run completed.

## Out Of Scope

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
