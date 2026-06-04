# Board Search Session-Grouped Results

## Goal

Add a product-driven Search page to Muninn Board that behaves like a focused search engine for historical agent memory. Users should be able to enter a query, scope it by project and session, and receive a unified result structure organized by session.

The first version optimizes for this task:

- "I remember we discussed something before; help me find the relevant memory and original context."

It should not become an answer-generation surface in this version. It should return searchable evidence and context with clear provenance.

## Scope

In scope:

- Replace the current Search empty state with a usable search page.
- Keep `#/search` as the route.
- Add a Board UI search API that returns one unified result shape.
- Support request-level scoping by project and session.
- Render results grouped by session name.
- Show per-item source labels such as `extraction` and `conversation`.
- Support expandable result item bodies with a fixed preview height.
- Add demo data that exercises project, session, source, and expansion behavior.

Out of scope:

- No generated answer or summary at the top of results.
- No right-pane detail view for result links in this version.
- No edit workflow.
- No forward-compatible result schema variants.
- No front-end-only filtering after a broad global search.

## Search Page Interaction

The Search page has two layout states.

Initial state:

- Search input is centered slightly above the middle of the content area.
- A compact gray configuration row sits under the input.
- No result list is shown.

Submitted state:

- Search input moves to the top of the result area.
- The same configuration row remains under the input.
- Results render below the configuration row.

Search is explicit:

- Pressing Enter submits the search.
- Clicking the search button submits the search.
- Typing does not automatically issue search requests.
- Empty query does not submit.

## Search Controls

The configuration row contains these controls, with these exact labels:

- `Project`
- `Session`
- `Session Top N`
- `Top N`

`Project`:

- Defaults to `All`.
- Scopes the search request when a specific project is selected.

`Session`:

- Defaults to `All`.
- Disabled when `Project` is `All`.
- Shows only sessions from the selected project when a specific project is selected.
- Scopes the search request when a specific session is selected.

`Session Top N`:

- Controls how many hit items each session result may contain.
- Must be a positive integer.
- Should be exposed as a compact select or equivalent constrained control.

`Top N`:

- Controls how many session results the API returns.
- Must be a positive integer.
- Should be exposed as a compact select or equivalent constrained control.

## Result Rendering

Results are rendered as a list of session results.

Each session result:

- Uses the session name as the title.
- Shows a gray metadata line with `Project: <project>`.
- Contains up to `Session Top N` hit items.

Each hit item:

- Shows exactly one `Source` label, such as `Source: extraction` or `Source: conversation`.
- Shows the matched content as evidence-first text, not generated answer prose.
- Uses a fixed preview height by default.
- Shows an expand/collapse affordance when content exceeds the preview height.
- May carry link/reference data for future right-pane detail behavior.

The UI should not split rendering by underlying storage type. All results should flow through the same `session result -> hit items` structure.

## API

Add a Board-specific UI endpoint:

```http
GET /api/v1/ui/search
```

Request query parameters:

- `query`: required non-empty string.
- `projectKey`: optional. Missing or `all` means all projects.
- `sessionKey`: optional. Valid only when `projectKey` selects a specific project.
- `sessionTopN`: optional positive integer. Defaults to `3`.
- `topN`: optional positive integer. Defaults to `20`.

The endpoint returns:

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

The API is intentionally separate from the existing recall API. Existing recall behavior may be used internally, but it must not define the product-facing result structure.

## Retrieval And Aggregation

Search backends should normalize raw hits into candidates before grouping:

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

The first version should cover two source classes:

- `conversation`: session or turn title, summary, prompt, response, and rendered conversation content.
- `extraction`: distilled memory extraction content.

Aggregation rules:

1. Apply project and session scope during retrieval.
2. Rank candidates by relevance.
3. Group candidates by `sessionKey`.
4. Sort each session's items by score and keep `Session Top N`.
5. Sort session results by the best score in each session.
6. Use `latestUpdatedAt` as a deterministic tie-breaker.
7. Return only `Top N` session results.

This design treats the returned session result as the primary search unit. Multiple matching topics inside the same session remain one session result with multiple hit items.

## States And Errors

UI states:

- Initial: centered search input and configuration row.
- Loading: keep the input and controls visible; show loading in the result area.
- Results: show session-grouped results.
- No results: show `No results found.` and preserve the current query and controls.
- Error: show the backend error message and preserve the current query and controls.

Validation:

- Empty query does not send a request.
- `Session` is disabled when `Project` is `All`.
- `sessionKey` is not sent when `Project` is `All`.
- The API rejects `sessionKey` when `projectKey` is missing or `all`.
- Invalid `Session Top N` or `Top N` values are prevented by constrained UI controls and rejected by the API if received.

Expansion state:

- Each hit item expands and collapses independently.
- A new search response resets prior expansion state.

## Testing And Acceptance Criteria

API tests:

- `GET /api/v1/ui/search` rejects missing or blank `query`.
- Invalid `sessionTopN` and `topN` values are rejected.
- `sessionKey` without a specific `projectKey` is rejected.
- Scoped project search returns only results from that project.
- Scoped session search returns only results from that session.
- Results are grouped by session.
- Each session result contains no more than `Session Top N` items.
- The response contains no more than `Top N` session results.

Board client and UI tests:

- The client parses `SearchResponse`.
- Initial state renders centered search input and controls.
- Enter and search button submit the query.
- Typing alone does not submit the query.
- `Project = All` disables `Session`.
- Selecting a project enables `Session` and narrows its options to that project.
- Result cards render session title, `Project` metadata, hit item `Source`, preview content, and expand/collapse behavior.
- No-results, loading, and error states are visible and stable.

Demo data:

- At least two projects.
- At least one project with multiple sessions.
- At least one session with both `extraction` and `conversation` hit items.
- At least one long hit item that exercises expansion.
