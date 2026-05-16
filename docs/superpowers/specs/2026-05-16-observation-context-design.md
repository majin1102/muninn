# Observation Context Design

## Goal

Replace whole-entity observer rewrites with a current-state hierarchical observation document.

The observer should update only the relevant parts of an observation tree when extractions change. Lance dataset versions provide historical time travel, so the business tables should store current data, not append-only domain snapshots.

Target flow:

```text
turn -> session extraction -> extraction -> observation_context -> observation
```

## Tables

### extraction

`extraction` is a search/source memory layer produced by the session extractor. Its id is stable and must survive content updates.

```ts
type Extraction = {
  id: string;                 // UUID
  text: string;
  context?: string | null;
  anchors: string[];          // "key: value"
  turnRefs: string[];         // original turn/source refs
  observationIds: string[];   // direct leaf observation ids only
  observedRootAnchors: string[];
  vector: number[];
  importance: number;
  category: string;
  createdAt: string;
  updatedAt: string;
};
```

Rules:

- `anchors` stays as `string[]`; business logic parses `key: value` into an anchor map.
- Unknown anchor keys are accepted. MVP root construction only uses `Entity` anchors.
- `observationIds` stores bare UUIDs, not prefixed memory ids.
- `observationIds` only records direct leaf observations that explicitly reference the extraction.
- `observedRootAnchors` records root anchors already processed by the observer, even when no observation was produced.
- Updating an extraction keeps `id` and `observationIds`, updates `updatedAt`, and clears affected `observedRootAnchors`.
- Extraction updates must be stable upserts by UUID, not delete plus insert.

### observation_context

`observation_context` is the authoritative current hierarchical document. It is not a snapshot/history table.

```ts
type ObservationContext = {
  id: string;                 // UUID, also the heading id
  observingPath: string;      // readable full path
  parentId?: string | null;
  position: number;           // sibling order
  content: string;            // this heading's own body only, no children
  createdAt: string;
  updatedAt: string;
  observer: string;
};
```

Rules:

- The table stores current state only. Lance versions provide historical time travel.
- `content` is only the current heading's body. Children are represented by `parentId`.
- Empty-content non-leaf nodes are valid organization nodes.
- Empty-content leaf nodes are invalid.
- The root anchor heading cannot be renamed, moved, or deleted.
- Root and non-leaf nodes may have content. If they have content, they can produce an observation row.
- `position` preserves document order among siblings.

### observation

`observation` is the current search index. It is derived from `observation_context`.

```ts
type Observation = {
  id: string;                 // same UUID as observation_context.id
  observingPath: string;
  text: string;               // displayPath(observingPath) + "\n\n" + content
  vector: number[];
  extractionRefs: string[];   // extraction UUIDs
  createdAt: string;
  updatedAt: string;
};
```

Rules:

- `observation.id = observation_context.id`.
- A context node with content generates or updates an observation row.
- A context node without content does not generate an observation row.
- Leaf observation `extractionRefs` come from the leaf heading `refs`.
- Non-leaf observation `extractionRefs` are computed from all descendant leaf refs.
- Non-leaf aggregate refs do not write back to `extraction.observationIds`.
- A non-leaf node with content is valid only when its descendants provide at least one leaf ref.
- `observation.text` always includes readable path plus content for self-contained recall.

## Markdown Format

The model edits Markdown, not JSON actions.

```md
# entity:Caroline <!-- id: 550e8400-e29b-41d4-a716-446655440000 -->

## Career and education <!-- id: 4ce9ff4b-07e3-4bb7-bd07-30a3e5a9d883 -->
Caroline plans to continue her education and explore career options.

### Counseling interest <!-- id: 8cd5e213-d2ad-4a24-a313-9e9b62389587; refs: [8dcb6f54-b2c0-4ec1-a0c3-4a4a7656e1d0] -->
Caroline is interested in counseling or mental health work.

### Summer adoption research <!-- refs: [4a319a62-3c48-4835-89d2-43c2da87101e] -->
Caroline's summer plans include researching adoption agencies.

----
## Duplicate note <!-- id: adcb41a2-9a6b-4c1a-a0a8-98b9b81a7219; delete: true -->
```

Heading hints:

- `id` is the stable observation/context node UUID.
- Existing headings keep their `id`.
- New headings omit `id`; the system assigns one.
- `refs` are extraction ids.
- Only leaf headings carry `refs`.
- Non-leaf headings must not carry `refs`.
- `delete: true` deletes the heading and its entire subtree.
- Multiple rewritten fragments are separated by a line containing exactly `----`.

Document structure:

- The memory is a natural hierarchical document, not a flat label list.
- Parent sections summarize, frame, or introduce the shared subject of child sections.
- Child sections expand, specialize, give concrete cases, or split subtopics under the parent.
- Root anchor is fixed. Sections under the root may be rewritten, renamed, moved, split, merged, created, or deleted.

## Observer Loop

There is one observer loop, not separate routing and rewrite loops.

Input:

- changed extractions, batched by root `Entity` anchor;
- full outline for the root tree, with headings and ids but no body text;
- linked content trees for observations directly referenced by changed extractions;
- `memory-get`, which expands observation context subtrees by observation id.

Output:

- partial rewritten Markdown fragments containing every section the model changed;
- omitted sections are unchanged;
- deletion must be explicit with `delete: true`.

Tool behavior:

- `memory-get` accepts observation ids.
- One call expands at most 5 ids.
- It returns the full content subtree by default.
- If a subtree exceeds `observer.memoryGetMaxChars` (default 12000), it returns the requested node content plus children outline and asks the model to expand smaller children if needed.

Loop limits:

- `observer.batchSize = 16` extractions per root batch.
- `observer.maxSteps = 5`.

## Pending and Update Semantics

New extraction:

```text
Entity anchors -> root tree -> observer loop with outline -> rewritten fragments -> context/observation/extraction links
```

Updated extraction:

```text
extraction.observationIds -> direct leaf observations -> linked content trees -> observer loop -> rewritten fragments
```

Pending rules:

- New root pending is based on `Entity` anchors not present in `observedRootAnchors` and not already linked through `observationIds`.
- Linked update pending exists when `extraction.updatedAt > observation.updatedAt` for a linked direct leaf observation.
- If observer decides not to write an extraction into any observation, it still records the root in `observedRootAnchors`.

Constraints:

- One extraction can enter multiple root trees.
- Within one root tree, one extraction can appear in refs for only one leaf.
- If the same extraction appears in multiple leaf refs under one root, validation fails and the loop retries.
- Ancestor aggregate refs do not count as direct leaf conflicts.

## Diff and Apply

The observer output is parsed and applied as a partial document diff.

Rules:

- Existing id with changed body updates that context node.
- Existing id with changed heading text updates `observingPath` and descendants' paths.
- Existing id nested under a different parent moves the subtree within the current root.
- Missing existing ids are unchanged.
- `delete: true` deletes that node and subtree.
- Heading without id creates a new context node; the system assigns a UUID.
- New UUIDs are patched into normalized Markdown and stored in the job artifact/checkpoint before write, so retries are idempotent.

Apply order:

```text
1. parse and validate Markdown
2. diff context nodes
3. determine observation rows requiring upsert/delete
4. generate embeddings only for changed observation text
5. write observation_context rows
6. upsert/delete observation rows
7. sync extraction.observationIds and observedRootAnchors
8. on failure, fail the job and retry
```

There is no cross-table transaction in MVP. The apply path must be idempotent.

## Rendering

To render a tree:

```text
load observation_context rows
build children by parentId
sort siblings by position
join observation rows by id for refs
render heading + id + optional refs + content
```

Outline rendering omits content and refs. Content-tree rendering includes content and leaf refs.

## Non-Goals

- Do not change `session_snapshot` in this work. It still owns current extractor replay/checkpoint behavior.
- Do not preserve old observer/curation schema compatibility.
- Do not expose `observation_context` as a public memory-get object outside the observer loop.
- Do not add a separate observation link table.
- Do not keep business-level history in `observation_context`; use Lance versions for time travel.
