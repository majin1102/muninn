# Board Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the final Board Search experience described in `docs/superpowers/specs/2026-06-04-board-search-design.md`.

**Architecture:** Keep search product behavior behind a Board-specific `/api/v1/ui/search` endpoint that returns one session-grouped result shape. The React page owns the Codex-style composer and local control state, while server code owns candidate normalization, scoping, ranking, grouping, and response shaping.

**Tech Stack:** TypeScript, React, Hono, lucide-react, Node test runner, pnpm workspace scripts.

---

## File Structure

- Modify `packages/types/src/api.ts`
  - Define `SearchResponse`, `SearchSessionResult`, `SearchResultItem`, and `SearchResultLink`.
- Modify `packages/board/src/lib/search_state.ts`
  - Own `SearchControlsState`, defaults, repeated query param construction, multi-project session options, and positive integer normalization.
- Modify `packages/board/src/lib/api.ts`
  - Add `BoardClient.search()` with repeated `projectKey` and `sessionKey` params.
- Modify `packages/board/src/server/search.ts`
  - Normalize conversation/extraction hits into candidates and group them by session.
- Modify `packages/board/src/server/app.ts`
  - Add `GET /api/v1/ui/search` route parsing and validation.
- Modify `packages/board/src/components/SearchPage.tsx`
  - Render the Codex-style composer, control menus, provider selector, session-grouped results, and expand/collapse.
- Modify `packages/board/src/styles.css`
  - Add composer, menu, long-label, result, and submitted-state styles.
- Modify `packages/board/src/demo/data.ts`
  - Add search fixtures including long project/session labels.
- Modify `packages/board/src/demo/provider.ts`
  - Add demo search filtering with project/session multi-select support.
- Test `packages/board/test/search-state.test.mjs`
  - Cover query param construction, multi-project sessions, and numeric normalization.
- Test `packages/board/test/search-server.test.mjs`
  - Cover grouping and request scope.
- Test `packages/sidecar/test/session_flow.test.mjs`
  - Cover the integrated Board search endpoint.

## Task 1: Search Contract And Control State

**Files:**
- Modify: `packages/types/src/api.ts`
- Modify: `packages/board/src/lib/search_state.ts`
- Modify: `packages/board/test/search-state.test.mjs`

- [ ] **Step 1: Write the failing search-state tests**

Use `packages/board/test/search-state.test.mjs` to load `search_state.ts` through TypeScript transpilation and assert final control behavior:

```js
test('buildSearchParams appends multi-select scope params', async () => {
  const { buildSearchParams } = await loadSearchState();
  const params = buildSearchParams({
    query: 'board search',
    projectKeys: ['muninn', 'lance'],
    sessionKeys: ['muninn/search-design', 'lance/vector-notes'],
    sessionTopN: 5,
    topN: 30,
  });

  assert.deepEqual([...params.entries()], [
    ['query', 'board search'],
    ['sessionTopN', '5'],
    ['topN', '30'],
    ['projectKey', 'muninn'],
    ['projectKey', 'lance'],
    ['sessionKey', 'muninn/search-design'],
    ['sessionKey', 'lance/vector-notes'],
  ]);
});

test('sessionOptionsForProjects lists all sessions until projects are selected', async () => {
  const { sessionOptionsForProjects } = await loadSearchState();
  const projects = makeProjects();

  assert.deepEqual(
    sessionOptionsForProjects(projects, []).map((option) => option.value),
    ['muninn/search-design', 'lance/vector-notes'],
  );
  assert.deepEqual(sessionOptionsForProjects(projects, ['muninn']), [{
    label: 'search-design',
    value: 'muninn/search-design',
    agent: 'codex_cli',
  }]);
});
```

- [ ] **Step 2: Run the failing test**

Run:

```sh
source ~/.zprofile && node --test packages/board/test/search-state.test.mjs
```

Expected before implementation: failures showing missing `projectKeys`/`sessionKeys` support.

- [ ] **Step 3: Add final shared response contract**

In `packages/types/src/api.ts`, define:

```ts
export interface SearchResultLink {
  kind: 'memory' | 'turn' | 'session';
  label: string;
  memoryId?: string;
  sessionKey?: string;
}

export interface SearchResultItem {
  id: string;
  source: 'extraction' | 'conversation';
  title?: string;
  content: string;
  createdAt?: string;
  memoryId?: string;
  links: SearchResultLink[];
}

export interface SearchSessionResult {
  sessionKey: string;
  sessionLabel: string;
  projectKey: string;
  latestUpdatedAt: string;
  items: SearchResultItem[];
}

export interface SearchResponse {
  results: SearchSessionResult[];
  requestId: string;
}
```

- [ ] **Step 4: Implement final search state helpers**

In `packages/board/src/lib/search_state.ts`, use the final state shape:

```ts
export type SearchControlsState = {
  query: string;
  projectKeys: string[];
  sessionKeys: string[];
  sessionTopN: number;
  topN: number;
};

export function buildSearchParams(state: SearchControlsState): URLSearchParams {
  const params = new URLSearchParams({
    query: state.query.trim(),
    sessionTopN: String(state.sessionTopN),
    topN: String(state.topN),
  });

  for (const projectKey of state.projectKeys) {
    params.append('projectKey', projectKey);
  }
  for (const sessionKey of state.sessionKeys) {
    params.append('sessionKey', sessionKey);
  }

  return params;
}
```

Add `sessionOptionsForProjects(projects, projectKeys)` so empty project selection returns all sessions and selected projects narrow the session menu.

- [ ] **Step 5: Verify Task 1**

Run:

```sh
source ~/.zprofile && node --test packages/board/test/search-state.test.mjs
```

Expected: all search-state tests pass.

## Task 2: Board Search API And Aggregation

**Files:**
- Modify: `packages/board/src/server/search.ts`
- Modify: `packages/board/src/server/app.ts`
- Modify: `packages/board/test/search-server.test.mjs`
- Modify: `packages/sidecar/test/session_flow.test.mjs`

- [ ] **Step 1: Write server tests for session grouping and scope**

In `packages/board/test/search-server.test.mjs`, cover:

```js
test('conversationCandidates respects query, project, and session scope', async () => {
  const { __testing } = await loadSearchServer();
  const candidates = __testing.conversationCandidates(makeTurns(), {
    query: 'search',
    projectKeys: ['muninn'],
    sessionKeys: ['muninn/search-design'],
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].projectKey, 'muninn');
  assert.equal(candidates[0].sessionKey, 'muninn/search-design');
});
```

In `packages/sidecar/test/session_flow.test.mjs`, add a Board endpoint test that requests repeated scope params:

```js
const response = await app.request('/api/v1/ui/search?query=search&projectKey=muninn&sessionKey=muninn/search-design&sessionTopN=1&topN=1');
assert.equal(response.status, 200);
const body = await response.json();
assert.equal(body.results.length, 1);
assert.equal(body.results[0].items.length, 1);
```

- [ ] **Step 2: Run the failing server tests**

Run:

```sh
source ~/.zprofile && node --test packages/board/test/search-server.test.mjs
source ~/.zprofile && node --test --test-name-pattern "board search" packages/sidecar/test/session_flow.test.mjs
```

Expected before implementation: missing endpoint or missing multi-select scope support.

- [ ] **Step 3: Implement `searchBoardMemory()`**

In `packages/board/src/server/search.ts`, accept:

```ts
export type BoardSearchParams = {
  query: string;
  projectKeys?: string[];
  sessionKeys?: string[];
  sessionTopN: number;
  topN: number;
};
```

Normalize both conversation turns and recall hits into a `SearchCandidate`, filter with:

```ts
function matchesScope(
  projectKey: string,
  sessionKey: string,
  scope: { projectKeys?: string[]; sessionKeys?: string[] },
): boolean {
  const projectKeys = new Set(scope.projectKeys ?? []);
  const sessionKeys = new Set(scope.sessionKeys ?? []);
  if (projectKeys.size > 0 && !projectKeys.has(projectKey)) {
    return false;
  }
  if (sessionKeys.size > 0 && !sessionKeys.has(sessionKey)) {
    return false;
  }
  return true;
}
```

Group by `sessionKey`, sort items by score, keep `sessionTopN`, sort session groups by best score and `latestUpdatedAt`, then keep `topN`.

- [ ] **Step 4: Add `/api/v1/ui/search`**

In `packages/board/src/server/app.ts`, parse repeated params:

```ts
function normalizeTextList(values: string[] | undefined): string[] {
  return [...new Set((values ?? [])
    .map((value) => normalizeText(value))
    .filter((value): value is string => Boolean(value) && value !== 'all'))];
}
```

Use:

```ts
const projectKeys = normalizeTextList(c.req.queries('projectKey'));
const sessionKeys = normalizeTextList(c.req.queries('sessionKey'));
```

Do not reject session-only scope.

- [ ] **Step 5: Verify Task 2**

Run:

```sh
source ~/.zprofile && node --test packages/board/test/search-server.test.mjs
source ~/.zprofile && node --test --test-name-pattern "board search" packages/sidecar/test/session_flow.test.mjs
```

Expected: all targeted server tests pass.

## Task 3: Search Page UI

**Files:**
- Modify: `packages/board/src/components/SearchPage.tsx`
- Modify: `packages/board/src/lib/api.ts`
- Modify: `packages/board/src/styles.css`

- [ ] **Step 1: Add `BoardClient.search()`**

In `packages/board/src/lib/api.ts`, add:

```ts
search(params: {
  query: string;
  projectKeys?: string[];
  sessionKeys?: string[];
  sessionTopN: number;
  topN: number;
}): Promise<SearchResponse>;
```

Build request params by appending repeated `projectKey` and `sessionKey` values.

- [ ] **Step 2: Build the Codex-style composer**

In `packages/board/src/components/SearchPage.tsx`, render:

```tsx
<h1 className="search-prompt-title">What do you want to know</h1>
<textarea
  value={controls.query}
  placeholder="Search memories"
  rows={3}
  onChange={(event) => patchControls({ query: event.target.value })}
  onInput={resizeTextarea}
  onKeyDown={submitFromTextarea}
/>
```

Provider selector uses:

```tsx
<SearchSelectMenu
  icon={BotMessageSquare}
  label="Provider"
  value={provider}
  options={PROVIDER_OPTIONS}
  open={openMenu === 'provider'}
  hideLabel
  onToggle={() => toggleMenu('provider')}
  onChange={(value) => {
    setProvider(value);
    setOpenMenu(null);
  }}
/>
```

- [ ] **Step 3: Build Top, Project, and Session menus**

Use `SearchTopMenu` for editable `Global` and `Session` numeric inputs. Use `SearchMultiSelectMenu` for `Project` and `Session`.

Session menu rows include agent icons:

```tsx
optionIcon={(option) => (option.agent ? <AgentLogoMark logo={logoForAgent(option.agent)} /> : null)}
```

When selected projects change, remove selected sessions that are no longer allowed:

```ts
const allowedSessions = new Set(sessionOptionsForProjects(projects, projectKeys).map((option) => option.value));
sessionKeys: current.sessionKeys.filter((sessionKey) => allowedSessions.has(sessionKey))
```

- [ ] **Step 4: Render unified session results**

Render each `SearchSessionResult` with:

- Session title as the top line.
- Metadata line `Project: <projectKey>`.
- Hit item rows with one `Source: <source>` label.
- Fixed preview content.
- Expand/collapse button per hit.

Reset expansion state when a new search starts.

- [ ] **Step 5: Add final styles**

In `packages/board/src/styles.css`, implement:

```css
.search-popover {
  width: max-content;
  min-width: 220px;
  max-width: min(520px, calc(100vw - 96px));
  overflow: hidden;
}

.search-menu-label {
  display: block;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

Keep the submit button icon-only and small, and keep the provider font at the same control scale as the composer toolbar.

- [ ] **Step 6: Verify Task 3 visually**

Run the Board dev server and open:

```text
http://localhost:18080/board/?demo=1#/search
```

Expected:

- Slogan reads `What do you want to know`.
- Provider selector uses `BotMessageSquare`.
- Search box is multi-line.
- `Top`, `Project`, and `Session` are in the gray row.
- Project/Session menus are multi-select.
- Long labels stay one line and do not escape the menu boundary.

## Task 4: Demo Data And Final Verification

**Files:**
- Modify: `packages/board/src/demo/data.ts`
- Modify: `packages/board/src/demo/provider.ts`
- Test: `packages/board/test/search-state.test.mjs`
- Test: `packages/board/test/search-server.test.mjs`
- Test: `packages/sidecar/test/session_flow.test.mjs`

- [ ] **Step 1: Add final demo fixtures**

In `packages/board/src/demo/data.ts`, include a long project/session sample:

```ts
const LONG_DEMO_PROJECT = 'memory-inbox-with-a-very-long-project-name-for-cross-agent-recall';
const LONG_DEMO_SESSION = 'memory-inbox/daily-recall-and-cross-agent-search-regression-review-session';
```

Add a search result and a session group row using those labels so `demo=1` exposes the final long-title behavior.

- [ ] **Step 2: Add demo filtering**

In `packages/board/src/demo/provider.ts`, implement:

```ts
const projectKeys = new Set(params.projectKeys ?? []);
const sessionKeys = new Set(params.sessionKeys ?? []);
return demoSearchResults
  .filter((result) => projectKeys.size === 0 || projectKeys.has(result.projectKey))
  .filter((result) => sessionKeys.size === 0 || sessionKeys.has(result.sessionKey))
  .map((result) => ({
    ...result,
    items: result.items.filter((item) => (
      !query
      || result.sessionLabel.toLowerCase().includes(query)
      || item.title?.toLowerCase().includes(query)
      || item.content.toLowerCase().includes(query)
    )).slice(0, params.sessionTopN),
  }))
  .filter((result) => result.items.length > 0)
  .slice(0, params.topN);
```

- [ ] **Step 3: Run final tests**

Run:

```sh
source ~/.zprofile && node --test packages/board/test/search-state.test.mjs packages/board/test/search-server.test.mjs
source ~/.zprofile && node --test --test-name-pattern "board search" packages/sidecar/test/session_flow.test.mjs
source ~/.zprofile && pnpm --filter @muninn/board build
```

Expected:

- `search-state.test.mjs`: all tests pass.
- `search-server.test.mjs`: all tests pass.
- `session_flow.test.mjs` board search test passes.
- `@muninn/board` build completes successfully.

- [ ] **Step 4: Commit**

Run:

```sh
git add packages/types/src/api.ts packages/board/src/lib/search_state.ts packages/board/src/lib/api.ts packages/board/src/server/search.ts packages/board/src/server/app.ts packages/board/src/components/SearchPage.tsx packages/board/src/styles.css packages/board/src/demo/data.ts packages/board/src/demo/provider.ts packages/board/test/search-state.test.mjs packages/board/test/search-server.test.mjs packages/sidecar/test/session_flow.test.mjs
git commit -m "feat: add board search experience"
```

Expected: a Conventional Commits feature commit containing the Board Search implementation.

## Self-Review

- Spec coverage: Tasks cover composer, controls, multi-select scoping, API, grouping, demo data, and verification.
- Placeholder scan: No deferred-work placeholders remain in this plan.
- Type consistency: Plan uses `projectKeys`, `sessionKeys`, `sessionTopN`, `topN`, and `SearchSessionResult` consistently with the final design.
