# Session Pagination And Timeline Split Design

## Summary

Session clicks should show the conversation quickly. The current app route accepts `offset` and `limit`, but the server still reads a very large turn window, filters it in JavaScript, builds the full timeline, and only then slices the requested page. The response is paged, but the work is not.

This design makes session turns a real paged backend query, splits timeline loading into its own route, and adds turn-position lookup for fast citation jumps.

## Goals

- Load the first conversation page independently from timeline data.
- Query session turns by `project`, `agent`, `sessionId`, `offset`, and `limit` without the web route reading `SESSION_TREE_PAGE_LIMIT = 1_000_000`.
- Let Timeline show its own `loading timeline...` state without blocking conversation rendering.
- Remove fallback turn segments from timeline loading. If there is no snapshot/extraction timeline, timeline and segments are empty.
- Support jumping from a timeline citation to an unloaded turn through a `turn-position` route.

## Non-Goals

- Do not change persisted schemas.
- Do not change dreaming behavior.
- Do not add virtualized rendering.
- Do not preserve the old `SessionTurnsResponse` shape with timeline and segments.

## API Design

### Paged Turns

`GET /app/api/session/agents/:agent/sessions/:sessionKey/turns?project=<project>&offset=<n>&limit=<n>`

Returns:

```ts
{
  turns: TurnPreview[];
  nextOffset: number | null;
  requestId: string;
}
```

The route queries `limit + 1` rows. It returns at most `limit` turns and sets `nextOffset = offset + limit` only when the extra row exists.

### Timeline

`GET /app/api/session/agents/:agent/sessions/:sessionKey/timeline?project=<project>`

Returns:

```ts
{
  timeline: SessionTimelineItem[];
  segments: SessionSegmentPreview[];
  requestId: string;
}
```

The route builds timeline from the latest session snapshot. It does not read all session turns. Extraction refs are resolved by fetching only referenced turn ids; missing refs fall back to snapshot timestamps.

### Turn Position

`GET /app/api/session/agents/:agent/sessions/:sessionKey/turn-position?project=<project>&turnId=<turn:123>`

Returns:

```ts
{
  turnId: string;
  offset: number;
  requestId: string;
}
```

The route checks that the target turn belongs to the requested project, agent, and session. It computes the 0-based position among previewable turns using the same ordering as the turns route, then returns the page start offset for the current page size.

## Backend Design

- Add `project?: string` to the `turns.list` path from `server/src/backend.ts` through `server/src/api/memory.ts`, `server/src/native.ts`, `server/native/src/lib.rs`, and `format/src/turn.rs`.
- Add a dedicated filtered turn-list query in Rust that pushes `project`, `agent`, `session_id`, and `extractor` filtering into the Lance scan where available.
- Keep stable ordering by `created_at`, then `updated_at`, then `turn_id`.
- Remove the web route's `SESSION_TREE_PAGE_LIMIT` turn load from the session page path.
- Keep `loadAllSessionTurns()` only for session tree grouping if still needed.

## Frontend Design

- Add `timelineLoading` and `timelineLoaded` to `ProjectSessionNode`.
- `openSession()` first loads paged turns and clears conversation loading.
- `openSession()` then starts timeline loading separately.
- `loadMore()` loads only more turns and does not refresh timeline.
- `locateConversationTurn()` calls the new `turn-position` route, loads the target page if needed, then focuses the target turn.

## Acceptance Criteria

- Clicking a session no longer waits for timeline construction before conversation appears.
- The turns route response contains only `turns`, `nextOffset`, and `requestId`.
- The web session turns route no longer reads `SESSION_TREE_PAGE_LIMIT = 1_000_000`.
- Timeline loading is independent and may complete after conversation.
- Citation jumps to unloaded turns use `turn-position` instead of repeated page scanning.
