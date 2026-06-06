# Dual Route Recall Design

## Goal

Muninn should recall from both curated memory and raw session-level extraction.
Curated `observation` rows are higher-level memory produced by curation.
Raw `extraction` rows are lower-level extractions used as fallback and evidence.

The first version is deterministic. It does not introduce an agentic recall loop or new user-facing configuration.

## Current Context

The current recall path searches only `extractionTable`.

Existing storage layers:

- `extraction`: session-level extracted memory units.
- `curation_snapshot`: curated markdown snapshots.
- `observation`: memory units derived from curation snapshots.

Current curation rows use `observation.references` to point at covered `extraction:<id>` rows. Those extraction rows then point at source session turns.

## Design

Recall should search two routes for the same query:

- Curated route: `observationTable.search(...)`
- Raw route: `extractionTable.search(...)`

The routes use the same recall mode and query vector where applicable.

After both searches, recall merges them with curated-first behavior:

1. Select curated hits first, up to `ceil(limit * 0.7)`.
2. Build `coveredExtractionIds` only from the selected curated hits.
3. Filter raw hits whose `memoryId` is covered by the selected curated hits.
4. Fill the raw quota with remaining raw hits.
5. If the result is still below `limit`, fill from remaining curated and raw hits in their original route order.

This keeps curation authoritative when selected, but preserves raw fallback so curation compression does not silently erase recall coverage.

## Fixed MVP Defaults

No new config is added in this version.

For `budget = 0`:

- `limit` is the final number of returned hits.
- Curated quota is `ceil(limit * 0.7)`.
- Raw quota is `limit - curatedQuota`.
- Search route limit is `limit`.

For `budget > 0`:

- `queryLimit` controls each route candidate count.
- `limit` does not control final output count.
- The same curated-first merge is used to form the candidate pool.
- The merged candidate pool is passed to `memory-recaller`.
- Recall returns a single synthetic `recalled:memory` hit.

## Coverage Filtering

Filtering raw hits must use selected curated hits only.

Do:

- Select curated hits that will actually be shown or passed to `memory-recaller`.
- Filter only raw `extraction:<id>` hits covered by those selected curated hits.
- Keep raw fallback hits that are not covered.

Do not:

- Filter raw hits using curated candidates that were searched but not selected.
- Treat a curated row as covering all raw hits from the same session.
- Flatten provenance in core recall.

## Memory IDs and References

Curated recall hits use `observation:<id>`.

Raw recall hits keep `extraction:<id>`.

Core recall should return curated hits as:

```ts
{
  memoryId: "observation:<id>",
  text: observation.text,
  references: ["extraction:<id>", ...]
}
```

The references stay as extraction ids. They should not be flattened to session turn ids inside core recall.

## Rendering

`memories.get("observation:<id>")` should render curated observations.

The rendered memory should expose enough detail for benchmark and debugging:

- `title` / `summary`: observation text.
- `detail`: references and any available curation metadata that already exists in the row.

The MVP should not add new observation table columns only for rendering.

## LoCoMo Evidence Resolution

The LoCoMo bridge must support recursive evidence resolution:

```text
observation:<id>
-> observation.references
-> extraction:<id>
-> extraction.references
-> source evidence ids
```

This keeps hidden recall scoring correct while preserving provenance structure.

## memory-recaller Integration

When `budget > 0`, the memory-recaller receives mixed candidates.

Candidate shape should preserve the source route:

```ts
{
  memoryId: "observation:<id>" | "extraction:<id>",
  content: string,
  context?: string,
  anchors?: string[],
  refs: string[]
}
```

Curated candidates should use observation text as `content`.
Raw candidates should use extraction text, context, and anchors as they do today.

The synthetic `recalled:memory` references are the unique union of the merged candidate pool refs. The MVP should not let the memory-recaller narrow evidence refs.

## Testing

Core tests:

- Searches both `observationTable` and `extractionTable`.
- Returns curated and raw hits when both exist.
- Filters raw extraction hits covered by selected curated hits.
- Does not filter raw hits covered only by unselected curated candidates.
- Fills from raw when curated is insufficient.
- Fills from remaining curated when raw is insufficient.
- `budget > 0` passes the merged candidate pool to memory-recaller.

Rendering tests:

- `memories.get("observation:<id>")` returns a rendered memory.
- Unknown observation ids return `null`.

LoCoMo bridge tests:

- `resolveEvidenceIds("observation:<id>")` resolves through extraction refs to source evidence ids.
- Direct `extraction:<id>` behavior remains unchanged.
- `recalled:memory` evidence behavior remains unchanged.

## Non-Goals

- No recall agent loop.
- No message grep.
- No new recall configuration.
- No curation coverage claims.
- No migration or compatibility for old benchmark outputs.
