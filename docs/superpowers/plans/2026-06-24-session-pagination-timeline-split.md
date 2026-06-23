# Session Pagination And Timeline Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Subagents are intentionally not used in this side conversation.

**Goal:** Make session conversation loading truly paged and independent from timeline loading.

**Architecture:** Push project/session turn filtering into the native turn-list path, split session timeline into a separate app route, and add a turn-position route for direct citation jumps. The web app stores conversation and timeline loading state separately.

**Tech Stack:** TypeScript React web app, Hono server routes, TypeScript native binding layer, Rust `format` turn table over Lance.

---

### Task 1: Contracts

**Files:**
- Modify: `common/src/api.ts`
- Modify: `web/src/lib/api.ts`

- [x] Remove `segments` and `timeline` from `SessionTurnsResponse`.
- [x] Add `SessionTimelineResponse`.
- [x] Add `SessionTurnPositionResponse`.
- [x] Add `timelineLoading` and `timelineLoaded` to `ProjectSessionNode`.
- [x] Add `loadSessionTimeline()` and `locateSessionTurn()` to `AppClient`.

### Task 2: Native Turn Filters

**Files:**
- Modify: `server/src/api/memory.ts`
- Modify: `server/src/backend.ts`
- Modify: `server/src/native.ts`
- Modify: `server/native/src/lib.rs`
- Modify: `format/src/turn.rs`

- [x] Thread optional `project` through the turn-list API.
- [x] Add project filtering to Rust turn table filtering.
- [x] Keep stable ordering for paged turns.

### Task 3: Session App Routes

**Files:**
- Modify: `server/src/web/sessions.ts`

- [x] Change `/turns` to query `limit + 1` rows and return only `turns` and `nextOffset`.
- [x] Add `/timeline` route returning `timeline` and `segments`.
- [x] Add `/turn-position` route returning the target page offset.
- [x] Remove fallback turn segments from timeline building.

### Task 4: Web Loading Flow

**Files:**
- Modify: `web/src/components/App.tsx`
- Modify: `web/src/components/SessionContentSplit.tsx`
- Modify: `web/src/components/TimelinePane.tsx`
- Modify: `web/src/lib/api.ts`

- [x] Load paged turns first in `openSession()`.
- [x] Load timeline independently after turns.
- [x] Use `timelineLoading` for Timeline pane loading.
- [x] Use turn-position lookup in `locateConversationTurn()`.

### Task 5: Tests

**Files:**
- Modify or add focused server/web tests under `server/test` and `web/test`.

- [x] Cover turns response shape and true paging route behavior.
- [x] Cover timeline response shape.
- [x] Cover turn-position offset calculation.
- [x] Cover web source behavior for split loading and locate flow.
- [x] Run `pnpm --filter @muninn/web test`.
- [x] Run focused server tests.
- [x] Run `pnpm --filter @muninn/server build`.
