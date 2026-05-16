# Observation Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the current-state `observation_context` hierarchy and derive searchable `observation` rows from observer Markdown.

**Architecture:** Add an `observation_context` Lance table as the authoritative current tree. Keep `observation` as the search index and update `extraction` with stable update fields and reverse links. Replace whole-document observer curation with partial Markdown rewrite parsing and deterministic diff/apply.

**Tech Stack:** Rust Lance storage in `format/`, TypeScript core bindings in `packages/core`, Node tests.

---

### Task 1: Storage Schema

**Files:**
- Modify: `format/src/extraction.rs`
- Modify: `format/src/observation.rs`
- Create: `format/src/observation_context.rs`
- Modify: `format/src/codec.rs`
- Modify: `format/src/schema.rs`
- Modify: `format/src/lib.rs`
- Modify: `packages/core/src/native.ts`

- [ ] Add `turn_refs`, `observation_ids`, `observed_root_anchors`, and `updated_at` to extraction.
- [ ] Rename observation `references` to `extraction_refs`, add `observing_path` and `updated_at`, remove observer snapshot fields.
- [ ] Add current-state `observation_context` table with `id`, `observing_path`, `parent_id`, `position`, `content`, timestamps, and `observer`.
- [ ] Update native TS types and bindings.

### Task 2: Markdown Parser and Renderer

**Files:**
- Modify: `packages/core/src/observer/markdown.ts`
- Modify: `packages/core/src/observer/types.ts`
- Test: `packages/core/test/observer-context.test.mjs`

- [ ] Parse partial Markdown fragments separated by `----`.
- [ ] Parse heading inline hints `id`, `refs`, and `delete: true`.
- [ ] Validate leaf/non-leaf refs rules.
- [ ] Assign system UUIDs to new headings before apply.
- [ ] Render outline and content subtrees from context rows plus observation refs.

### Task 3: Observer Apply Pipeline

**Files:**
- Modify: `packages/core/src/observer/runner.ts`
- Modify: `packages/core/src/llm/observing.ts`
- Test: `packages/core/test/observer-runner.test.mjs`
- Test: `packages/core/test/observer-observing.test.mjs`

- [ ] Replace current entity whole-document snapshot insertion with root-batched observation-context loop.
- [ ] Build full outline and linked content trees.
- [ ] Add observer `memory-get` for observation context subtrees.
- [ ] Apply partial Markdown diff to `observation_context`.
- [ ] Derive `observation` rows and sync `extraction.observationIds` / `observedRootAnchors`.

### Task 4: Recall and Evidence

**Files:**
- Modify: `packages/core/src/memories/rendered.ts`
- Modify: `packages/core/src/memories/recall.ts`
- Modify: `benchmark/locomo/src/bridge.ts`

- [ ] Use `observation.extractionRefs` for observation recall hits.
- [ ] Expand evidence through `observation.extractionRefs -> extraction.turnRefs`.
- [ ] Keep search tables query-only; memory-get only expands session/turn and observer-internal context subtrees.

### Task 5: Verification

**Commands:**
- `source ~/.zprofile && pnpm --filter @muninn/core build`
- `source ~/.zprofile && node --test packages/core/test/observer-context.test.mjs packages/core/test/observer-runner.test.mjs packages/core/test/observer-observing.test.mjs`
- `source ~/.zprofile && node --test packages/core/test/client-internals.test.mjs`

