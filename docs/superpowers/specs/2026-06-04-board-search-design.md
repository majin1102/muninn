# Board Search Experience Design

## Goal

Build a product-driven Search page for Muninn Board that behaves like a focused search engine for historical agent memory. Users enter a multi-line query, optionally scope it by project/session, and receive evidence grouped by session.

The first version optimizes for finding prior context, not generating an answer. Search should return provenance-rich results that can later link into a right-pane detail view.

## Scope

In scope:

- Keep `#/search` as the Board route.
- Replace the placeholder search view with a Codex-style composer.
- Add a Board UI search API with one unified session-grouped result shape.
- Support request-level scope by multiple projects and multiple sessions.
- Support configurable global Top and per-session Top values.
- Render results grouped by session.
- Render each hit with one source label, such as `conversation` or `extraction`.
- Render fixed-height previews with per-item expand/collapse.
- Add `demo=1` data that covers long project/session titles, multiple agents, and expandable result content.

Out of scope:

- No generated answer summary.
- No right-pane link target UI in this version.
- No edit workflow.
- No schema compatibility layer for obsolete search shapes.
- No front-end-only filtering after a broad backend search.

## Composer

The empty Search page centers a composer slightly above the page midpoint. The slogan is:

```text
Search context across all your agents
```

The composer mirrors the Codex interaction style:

- A white multi-line textarea.
- A compact lower row with a `+` menu, provider selector, and a small circular submit button.
- A gray configuration row below the input.
- Enter submits the query unless Shift is held or the input is composing text.
- Empty query disables submit.
- Typing alone does not issue requests.

The provider selector is visual-only in this version. It displays `Default` and uses the `BotMessageSquare` icon because it reads better than hardware-style icons at the current small size and matches the future model/provider use case.

The `+` menu is reserved for future multi-modal search. It exposes placeholder options for `Image`, `File`, and `Agent`.

After a search is submitted, the search area switches to a results-page layout:

- The search box is wider than the results column, following a Google-like search results layout.
- The default submitted state is a single-line compact search box with the query text and the submit button inside it.
- Clicking into the query expands back to the full composer, including `+`, Provider, `Top`, `Project`, and `Session`.
- Submitting blurs the query input and returns the search box to the compact one-line state.

Below the submitted search box, render source tabs:

1. `All`
2. `Observation`
3. `Conversation`
4. `LLM Wiki`

Only `All` is backed by real filtering in this version. The other tabs switch active UI state but return the same result set as `All`.

## Controls

The gray configuration row contains exactly these controls, in this order:

1. `Top <n>`
2. `Project <value>`
3. `Session <value>`

`Top <n>`:

- Opens a small menu with numeric inputs for `Global` and `Session`.
- `Global` controls how many session groups are returned.
- `Session` controls how many hit items may be returned inside each session group.
- Values must be positive integers.
- The collapsed label only shows the global value, for example `Top 20`.

`Project`:

- Defaults to `All`.
- Supports multi-select.
- Empty selection means all projects.
- A single selected project shows its label.
- Multiple selected projects show the selected count.
- Long project names stay on one line in the menu, with width expanding to content up to a viewport cap.

`Session`:

- Defaults to `All`.
- Supports multi-select.
- Empty selection means all sessions.
- The menu shows sessions from all selected projects; if no project is selected, it shows all sessions.
- The control button uses the same session icon as the left navigation.
- Session menu rows retain agent icons to help distinguish duplicate session names across agents.
- Long session names stay on one line in the menu, with width expanding to content up to a viewport cap.

## API

Add a Board UI endpoint:

```http
GET /api/v1/ui/search
```

Query parameters:

- `query`: required non-empty string.
- `projectKey`: optional repeated parameter. Missing or `all` means all projects.
- `sessionKey`: optional repeated parameter. Missing or `all` means all sessions.
- `sessionTopN`: optional positive integer. Defaults to `3`.
- `topN`: optional positive integer. Defaults to `20`.

The API accepts session-only scoping. A session filter does not require a project filter.

Response:

```ts
type SearchResponse = {
  results: SearchSessionResult[];
  requestId: string;
};

type SearchSessionResult = {
  sessionKey: string;
  sessionLabel: string;
  projectKey: string;
  latestUpdatedAt: string;
  items: SearchResultItem[];
};

type SearchResultItem = {
  id: string;
  source: 'extraction' | 'conversation';
  title?: string;
  content: string;
  createdAt?: string;
  memoryId?: string;
  links: SearchResultLink[];
};

type SearchResultLink = {
  kind: 'memory' | 'turn' | 'session';
  label: string;
  memoryId?: string;
  sessionKey?: string;
};
```

## Retrieval And Aggregation

Search normalizes raw matches into a single candidate structure before grouping:

```ts
type SearchCandidate = {
  sessionKey: string;
  sessionLabel: string;
  projectKey: string;
  latestUpdatedAt: string;
  source: 'extraction' | 'conversation';
  memoryId?: string;
  title?: string;
  content: string;
  createdAt?: string;
  score: number;
  links: SearchResultLink[];
};
```

Sources:

- `conversation`: title, summary, prompt, response, and rendered turn content.
- `extraction`: distilled memory extraction content.

Aggregation rules:

1. Apply project/session scope during candidate construction.
2. Rank candidates by relevance.
3. Group candidates by `sessionKey`.
4. Sort each session's hit items by score and keep `sessionTopN`.
5. Sort session groups by best item score.
6. Use `latestUpdatedAt` as deterministic tie-breaker.
7. Return only `topN` session groups.

The UI always renders the same structure regardless of whether a hit came from conversation text or extraction text.

## States

Initial:

- Centered slogan and composer.
- No result list.

Loading:

- Composer remains visible.
- Result area shows a loading state.

Results:

- Composer remains at the top.
- Results render as session groups.

No results:

- Show `No results found.`.
- Preserve query and controls.

Error:

- Show backend error text.
- Preserve query and controls.

Expansion:

- Each hit expands/collapses independently.
- New search response resets expansion state.

## Acceptance Criteria

- Search composer visually matches the Codex-style interaction agreed in the thread.
- Slogan text is `Search context across all your agents`.
- Provider selector uses `BotMessageSquare`.
- Search input supports multiple lines.
- Submitted search defaults to a single-line compact box and expands to the full composer on focus.
- Source tabs render as `All`, `Observation`, `Conversation`, and `LLM Wiki`; non-All tabs return the same result set as `All`.
- Submit button is small and icon-only.
- Top menu supports user-entered global and session numeric values.
- Project and Session support multi-select with `All` as empty selection.
- Project and Session menus expand for long labels and do not wrap labels.
- Session menu items show agent icons.
- API supports repeated `projectKey` and `sessionKey`.
- API supports session-only scope.
- Results are grouped by session with unified hit item rendering.
- Each hit shows exactly one source.
- Demo mode exercises long project/session names and expandable content.

## Verification

Run:

```sh
source ~/.zprofile && node --test packages/board/test/search-state.test.mjs packages/board/test/search-server.test.mjs
source ~/.zprofile && node --test --test-name-pattern "board search" packages/sidecar/test/session_flow.test.mjs
source ~/.zprofile && pnpm --filter @muninn/board build
```
