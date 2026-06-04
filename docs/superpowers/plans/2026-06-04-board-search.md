# Board Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Board Search page and API from `docs/superpowers/specs/2026-06-04-board-search-design.md`.

**Architecture:** Add a Board-specific search contract in `@muninn/types`, a focused server search module that normalizes conversation and extraction candidates into session-grouped results, and a `SearchPage` React component that renders explicit search controls and expandable session results. Keep the existing recall API as an internal source only; the Board UI consumes `/api/v1/ui/search`.

**Tech Stack:** TypeScript, Hono, React, lucide-react, Node test runner, pnpm workspace scripts.

---

## File Structure

- Modify `packages/types/src/api.ts`
  - Add `SearchResponse`, `SearchSessionResult`, `SearchResultItem`, and `SearchResultLink`.
- Create `packages/board/src/server/search.ts`
  - Own query validation inputs, candidate normalization, session grouping, scoring, and `searchBoardMemory()`.
  - Export `__testing` pure helpers for Node tests.
- Modify `packages/board/src/server/app.ts`
  - Add `GET /api/v1/ui/search`.
  - Keep route parsing and HTTP error behavior in `app.ts`; delegate search behavior to `search.ts`.
- Modify `packages/board/src/lib/api.ts`
  - Add `BoardClient.search()` and search-related client types.
  - Add demo-mode search call.
- Modify `packages/board/src/demo/data.ts`
  - Add demo search result fixture data.
- Modify `packages/board/src/demo/provider.ts`
  - Add `getDemoSearchResults()`.
- Create `packages/board/src/lib/search_state.ts`
  - Own UI-safe search defaults, query param construction, and project/session control state helpers.
- Create `packages/board/src/components/SearchPage.tsx`
  - Render the centered initial search state, submitted results state, controls, loading/error/no-result states, and expandable hit items.
- Modify `packages/board/src/components/App.tsx`
  - Replace the current `EmptyView` for `search` with `SearchPage`.
  - Reuse existing `client` and project loading flow.
- Modify `packages/board/src/styles.css`
  - Add Search page layout, controls, result list, and expandable preview styles.
- Create `packages/board/test/search-server.test.mjs`
  - Test pure server grouping/ranking/validation helpers.
- Create `packages/board/test/search-state.test.mjs`
  - Test UI helper behavior without adding a React test framework.
- Modify `packages/sidecar/test/session_flow.test.mjs`
  - Add integration coverage for `/api/v1/ui/search`.

## Task 1: Shared Search Contract And Demo Data

**Files:**
- Modify: `packages/types/src/api.ts`
- Modify: `packages/board/src/demo/data.ts`
- Modify: `packages/board/src/demo/provider.ts`
- Modify: `packages/board/src/lib/api.ts`
- Test: `packages/board/test/search-state.test.mjs`

- [ ] **Step 1: Add failing client/helper test**

Create `packages/board/test/search-state.test.mjs` with:

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadSearchState() {
  const source = await readFile(new URL('../src/lib/search_state.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

test('buildSearchParams omits sessionKey when project is all', async () => {
  const { buildSearchParams } = await loadSearchState();
  const params = buildSearchParams({
    query: 'board search',
    projectKey: 'all',
    sessionKey: 'muninn/session-a',
    sessionTopN: 3,
    topN: 20,
  });

  assert.equal(params.toString(), 'query=board+search&sessionTopN=3&topN=20');
});

test('sessionOptionsForProject disables sessions for all projects', async () => {
  const { sessionOptionsForProject } = await loadSearchState();
  const projects = [{
    projectKey: 'muninn',
    label: 'muninn',
    latestUpdatedAt: '2026-06-04T00:00:00.000Z',
    sessions: [{
      agent: 'codex_cli',
      sessionKey: 'muninn/search-design',
      displaySessionId: 'search-design',
      latestUpdatedAt: '2026-06-04T00:00:00.000Z',
      turns: [],
      segments: [],
      nextOffset: null,
      loading: false,
      loaded: false,
    }],
  }];

  assert.deepEqual(sessionOptionsForProject(projects, 'all'), []);
  assert.deepEqual(sessionOptionsForProject(projects, 'muninn'), [{
    label: 'search-design',
    value: 'muninn/search-design',
  }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
source ~/.zprofile && node --test packages/board/test/search-state.test.mjs
```

Expected: FAIL because `packages/board/src/lib/search_state.ts` does not exist.

- [ ] **Step 3: Add shared API types**

Append these interfaces to `packages/types/src/api.ts` before `SettingsConfigResponse`:

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

- [ ] **Step 4: Create search state helpers**

Create `packages/board/src/lib/search_state.ts`:

```ts
import type { ProjectNode } from './api.js';

export type SearchControlsState = {
  query: string;
  projectKey: string;
  sessionKey: string;
  sessionTopN: number;
  topN: number;
};

export const SEARCH_ALL_VALUE = 'all';
export const DEFAULT_SESSION_TOP_N = 3;
export const DEFAULT_TOP_N = 20;

export function defaultSearchControls(): SearchControlsState {
  return {
    query: '',
    projectKey: SEARCH_ALL_VALUE,
    sessionKey: SEARCH_ALL_VALUE,
    sessionTopN: DEFAULT_SESSION_TOP_N,
    topN: DEFAULT_TOP_N,
  };
}

export function buildSearchParams(state: SearchControlsState): URLSearchParams {
  const params = new URLSearchParams({
    query: state.query.trim(),
    sessionTopN: String(state.sessionTopN),
    topN: String(state.topN),
  });

  if (state.projectKey !== SEARCH_ALL_VALUE) {
    params.set('projectKey', state.projectKey);
    if (state.sessionKey !== SEARCH_ALL_VALUE) {
      params.set('sessionKey', state.sessionKey);
    }
  }

  return params;
}

export function sessionOptionsForProject(
  projects: ProjectNode[],
  projectKey: string,
): Array<{ label: string; value: string }> {
  if (projectKey === SEARCH_ALL_VALUE) {
    return [];
  }
  const project = projects.find((item) => item.projectKey === projectKey);
  if (!project) {
    return [];
  }
  return project.sessions.map((session) => ({
    label: session.displaySessionId,
    value: session.sessionKey,
  }));
}

export function normalizeSearchN(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
```

- [ ] **Step 5: Add demo search fixtures and provider**

In `packages/board/src/demo/data.ts`, import the new type and add this export near other demo exports:

```ts
import type { SearchSessionResult, ToolCall } from '@muninn/types';
```

Then add:

```ts
export const demoSearchResults: SearchSessionResult[] = [
  {
    sessionKey: 'auth-refactor',
    sessionLabel: 'auth-refactor',
    projectKey: 'auth-refactor',
    latestUpdatedAt: '2026-06-01T12:01:00.000Z',
    items: [
      {
        id: 'demo-search-auth-conversation-1',
        source: 'conversation',
        title: 'Board Search contract',
        content: 'The team decided the Search page should behave like a search engine and group results by session, with Project and Session controls shaping the request scope.',
        createdAt: '2026-06-01T12:01:00.000Z',
        memoryId: 'turn:1005',
        links: [{ kind: 'turn', label: 'Open turn', memoryId: 'turn:1005', sessionKey: 'auth-refactor' }],
      },
      {
        id: 'demo-search-auth-extraction-1',
        source: 'extraction',
        title: 'Request-level scope',
        content: 'Project and Session filters are request-level search scope, not client-side filtering after a broad result set has already been returned.',
        createdAt: '2026-06-01T12:05:00.000Z',
        memoryId: 'extraction:demo-auth-search-scope',
        links: [{ kind: 'memory', label: 'Open memory', memoryId: 'extraction:demo-auth-search-scope' }],
      },
    ],
  },
  {
    sessionKey: 'board-mvp',
    sessionLabel: 'board-mvp',
    projectKey: 'board-mvp',
    latestUpdatedAt: '2026-06-01T07:15:00.000Z',
    items: [{
      id: 'demo-search-board-long-1',
      source: 'conversation',
      title: 'Expandable result preview',
      content: [
        'Muninn Board Search uses a fixed-height preview for each hit item.',
        'Long evidence remains available through expand and collapse controls.',
        'This keeps session-level results scannable while preserving enough raw context for manual judgment.',
        'The first version does not generate answers or summaries at the top of the page.',
      ].join('\\n'),
      createdAt: '2026-06-01T07:15:00.000Z',
      memoryId: 'turn:1010',
      links: [{ kind: 'turn', label: 'Open turn', memoryId: 'turn:1010', sessionKey: 'board-mvp' }],
    }],
  },
];
```

In `packages/board/src/demo/provider.ts`, import `demoSearchResults` and add:

```ts
import type { SearchSessionResult } from '@muninn/types';
```

```ts
export async function getDemoSearchResults(params: {
  query: string;
  projectKey?: string;
  sessionKey?: string;
  sessionTopN: number;
  topN: number;
}): Promise<SearchSessionResult[]> {
  const query = params.query.trim().toLowerCase();
  const projectKey = params.projectKey && params.projectKey !== 'all' ? params.projectKey : undefined;
  const sessionKey = params.sessionKey && params.sessionKey !== 'all' ? params.sessionKey : undefined;
  return demoSearchResults
    .filter((result) => !projectKey || result.projectKey === projectKey)
    .filter((result) => !sessionKey || result.sessionKey === sessionKey)
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
}
```

- [ ] **Step 6: Extend BoardClient**

In `packages/board/src/lib/api.ts`, add `SearchResponse` to the `@muninn/types` import, add this method to `BoardClient`:

```ts
search(params: {
  query: string;
  projectKey?: string;
  sessionKey?: string;
  sessionTopN: number;
  topN: number;
}): Promise<SearchResponse>;
```

Import `getDemoSearchResults` from `../demo/provider.js`, then add this implementation inside `createBoardClient()`:

```ts
async search(params) {
  const searchParams = new URLSearchParams({
    query: params.query,
    sessionTopN: String(params.sessionTopN),
    topN: String(params.topN),
  });
  if (params.projectKey && params.projectKey !== 'all') {
    searchParams.set('projectKey', params.projectKey);
    if (params.sessionKey && params.sessionKey !== 'all') {
      searchParams.set('sessionKey', params.sessionKey);
    }
  }
  if (usesDemoData) {
    return {
      results: await getDemoSearchResults(params),
      requestId: 'demo-search',
    };
  }
  return fetchJson<SearchResponse>(`/api/v1/ui/search?${searchParams.toString()}`);
},
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
source ~/.zprofile && node --test packages/board/test/search-state.test.mjs
source ~/.zprofile && pnpm --filter @muninn/board exec tsc -p tsconfig.json --noEmit
```

Expected: both commands PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add packages/types/src/api.ts packages/board/src/demo/data.ts packages/board/src/demo/provider.ts packages/board/src/lib/api.ts packages/board/src/lib/search_state.ts packages/board/test/search-state.test.mjs
git commit -m "feat: add board search contract"
```

## Task 2: Server Search Aggregation Module

**Files:**
- Create: `packages/board/src/server/search.ts`
- Test: `packages/board/test/search-server.test.mjs`

- [ ] **Step 1: Add failing server search tests**

Create `packages/board/test/search-server.test.mjs`:

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadSearchServer() {
  const source = await readFile(new URL('../src/server/search.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

test('groupCandidates keeps top items per session and top sessions globally', async () => {
  const { __testing } = await loadSearchServer();
  const grouped = __testing.groupCandidates([
    candidate({ sessionKey: 's1', sessionLabel: 'Session 1', projectKey: 'muninn', id: 'a', score: 9 }),
    candidate({ sessionKey: 's1', sessionLabel: 'Session 1', projectKey: 'muninn', id: 'b', score: 8 }),
    candidate({ sessionKey: 's1', sessionLabel: 'Session 1', projectKey: 'muninn', id: 'c', score: 7 }),
    candidate({ sessionKey: 's2', sessionLabel: 'Session 2', projectKey: 'lance', id: 'd', score: 10 }),
  ], { sessionTopN: 2, topN: 1 });

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].sessionKey, 's2');
  assert.deepEqual(grouped[0].items.map((item) => item.id), ['d']);
});

test('conversationCandidates respects query, project, and session scope', async () => {
  const { __testing } = await loadSearchServer();
  const candidates = __testing.conversationCandidates([
    turn({ sessionId: 'muninn/search-a', prompt: 'board search contract', response: 'response' }),
    turn({ sessionId: 'muninn/search-b', prompt: 'other topic', response: 'response' }),
    turn({ sessionId: 'lance/search-a', prompt: 'board search contract', response: 'response' }),
  ], {
    query: 'board search',
    projectKey: 'muninn',
    sessionKey: 'muninn/search-a',
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sessionKey, 'muninn/search-a');
  assert.equal(candidates[0].source, 'conversation');
});

function candidate(overrides) {
  return {
    sessionKey: overrides.sessionKey,
    sessionLabel: overrides.sessionLabel,
    projectKey: overrides.projectKey,
    latestUpdatedAt: '2026-06-04T00:00:00.000Z',
    source: 'conversation',
    title: overrides.id,
    content: `content ${overrides.id}`,
    createdAt: '2026-06-04T00:00:00.000Z',
    score: overrides.score,
    links: [],
  };
}

function turn(overrides) {
  return {
    memoryId: `turn:${overrides.sessionId}`,
    sessionId: overrides.sessionId,
    agent: 'codex_cli',
    observer: 'default',
    title: overrides.prompt,
    summary: overrides.prompt,
    prompt: overrides.prompt,
    response: overrides.response,
    createdAt: '2026-06-04T00:00:00.000Z',
    updatedAt: '2026-06-04T00:00:00.000Z',
  };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
source ~/.zprofile && node --test packages/board/test/search-server.test.mjs
```

Expected: FAIL because `packages/board/src/server/search.ts` does not exist.

- [ ] **Step 3: Create server search module**

Create `packages/board/src/server/search.ts`:

```ts
import type {
  MemoryDocument,
  MemoryHit,
  SearchResultItem,
  SearchResultLink,
  SearchSessionResult,
} from '@muninn/types';
import type { memories, turns } from '@muninn/core';
import { sessionDisplayTitle } from './session_labels.js';

type BoardTurn = Awaited<ReturnType<typeof turns.list>>[number];

export type BoardSearchParams = {
  query: string;
  projectKey?: string;
  sessionKey?: string;
  sessionTopN: number;
  topN: number;
};

export type SearchCandidate = {
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

type SearchDeps = {
  listTurns: typeof turns.list;
  recall: typeof memories.recall;
  getDocument: typeof memories.get;
};

export async function searchBoardMemory(params: BoardSearchParams, deps: SearchDeps): Promise<SearchSessionResult[]> {
  const query = params.query.trim();
  if (!query) {
    return [];
  }

  const allTurns = await deps.listTurns({
    mode: { type: 'recency', limit: 1_000_000 },
  });
  const conversations = conversationCandidates(allTurns, {
    query,
    projectKey: params.projectKey,
    sessionKey: params.sessionKey,
  });

  const extractionHits = await deps.recall(query, Math.max(params.topN * params.sessionTopN, params.topN), {
    mode: 'hybrid',
    budget: 0,
  });
  const extractions = await extractionCandidates(extractionHits, deps.getDocument, {
    projectKey: params.projectKey,
    sessionKey: params.sessionKey,
  });

  return groupCandidates([...conversations, ...extractions], {
    sessionTopN: params.sessionTopN,
    topN: params.topN,
  });
}

function conversationCandidates(
  turns: BoardTurn[],
  scope: { query: string; projectKey?: string; sessionKey?: string },
): SearchCandidate[] {
  const query = scope.query.trim().toLowerCase();
  return turns.flatMap((turn) => {
    const sessionKey = turn.sessionId ?? '';
    const projectKey = projectKeyFromSessionKey(sessionKey);
    if (!sessionKey || !matchesScope(projectKey, sessionKey, scope)) {
      return [];
    }

    const text = [
      turn.title,
      turn.summary,
      turn.prompt,
      turn.response,
    ].filter((value): value is string => Boolean(value?.trim())).join('\n\n');
    const score = scoreText(text, query);
    if (score <= 0) {
      return [];
    }

    return [{
      sessionKey,
      sessionLabel: sessionDisplayTitle(sessionKey),
      projectKey,
      latestUpdatedAt: turn.updatedAt,
      source: 'conversation' as const,
      memoryId: turn.memoryId,
      title: turn.title ?? turn.summary,
      content: text,
      createdAt: turn.createdAt,
      score,
      links: [{
        kind: 'turn' as const,
        label: 'Open turn',
        memoryId: turn.memoryId,
        sessionKey,
      }],
    }];
  });
}

async function extractionCandidates(
  hits: MemoryHit[],
  getDocument: typeof memories.get,
  scope: { projectKey?: string; sessionKey?: string },
): Promise<SearchCandidate[]> {
  const candidates: SearchCandidate[] = [];
  for (const hit of hits) {
    if (!hit.memoryId.startsWith('extraction:') && !hit.memoryId.startsWith('observation:')) {
      continue;
    }
    const document = await getDocument(hit.memoryId);
    const candidate = document ? candidateFromDocument(hit, document, scope) : null;
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

function candidateFromDocument(
  hit: MemoryHit,
  document: MemoryDocument,
  scope: { projectKey?: string; sessionKey?: string },
): SearchCandidate | null {
  const sessionKey = document.sessionId;
  if (!sessionKey) {
    return null;
  }
  const projectKey = projectKeyFromSessionKey(sessionKey);
  if (!matchesScope(projectKey, sessionKey, scope)) {
    return null;
  }

  return {
    sessionKey,
    sessionLabel: sessionDisplayTitle(sessionKey),
    projectKey,
    latestUpdatedAt: document.updatedAt ?? document.createdAt ?? '',
    source: 'extraction',
    memoryId: hit.memoryId,
    title: document.title,
    content: hit.content,
    createdAt: document.createdAt,
    score: 100,
    links: [{
      kind: 'memory',
      label: 'Open memory',
      memoryId: hit.memoryId,
      sessionKey,
    }],
  };
}

function groupCandidates(
  candidates: SearchCandidate[],
  limits: { sessionTopN: number; topN: number },
): SearchSessionResult[] {
  const grouped = new Map<string, SearchCandidate[]>();
  for (const candidate of candidates) {
    const current = grouped.get(candidate.sessionKey) ?? [];
    current.push(candidate);
    grouped.set(candidate.sessionKey, current);
  }

  return [...grouped.entries()]
    .map(([sessionKey, items]) => {
      const sorted = items.slice().sort(compareCandidates);
      const first = sorted[0]!;
      return {
        sessionKey,
        sessionLabel: first.sessionLabel,
        projectKey: first.projectKey,
        latestUpdatedAt: sorted.reduce((latest, item) => item.latestUpdatedAt > latest ? item.latestUpdatedAt : latest, first.latestUpdatedAt),
        items: sorted.slice(0, limits.sessionTopN).map(candidateToItem),
        score: first.score,
      };
    })
    .sort((left, right) => (
      right.score - left.score
      || right.latestUpdatedAt.localeCompare(left.latestUpdatedAt)
    ))
    .slice(0, limits.topN)
    .map(({ score: _score, ...result }) => result);
}

function candidateToItem(candidate: SearchCandidate): SearchResultItem {
  return {
    id: `${candidate.source}:${candidate.memoryId ?? `${candidate.sessionKey}:${candidate.title ?? candidate.createdAt ?? ''}`}`,
    source: candidate.source,
    title: candidate.title,
    content: candidate.content,
    createdAt: candidate.createdAt,
    memoryId: candidate.memoryId,
    links: candidate.links,
  };
}

function compareCandidates(left: SearchCandidate, right: SearchCandidate): number {
  return right.score - left.score || (right.createdAt ?? '').localeCompare(left.createdAt ?? '');
}

function scoreText(text: string, query: string): number {
  const haystack = text.toLowerCase();
  if (haystack.includes(query)) {
    return 100 + query.length;
  }
  const terms = query.split(/\s+/).filter(Boolean);
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function matchesScope(
  projectKey: string,
  sessionKey: string,
  scope: { projectKey?: string; sessionKey?: string },
): boolean {
  if (scope.projectKey && projectKey !== scope.projectKey) {
    return false;
  }
  if (scope.sessionKey && sessionKey !== scope.sessionKey) {
    return false;
  }
  return true;
}

function projectKeyFromSessionKey(sessionKey: string): string {
  const [projectKey] = sessionKey.split('/').filter(Boolean);
  return projectKey || 'Default Project';
}

export const __testing = {
  conversationCandidates,
  groupCandidates,
  scoreText,
};
```

- [ ] **Step 4: Run server search tests**

Run:

```bash
source ~/.zprofile && node --test packages/board/test/search-server.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Run server TypeScript check**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/board exec tsc -p tsconfig.server.json --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add packages/board/src/server/search.ts packages/board/test/search-server.test.mjs
git commit -m "feat: add board search aggregation"
```

## Task 3: Search API Route

**Files:**
- Modify: `packages/board/src/server/app.ts`
- Modify: `packages/sidecar/test/session_flow.test.mjs`

- [ ] **Step 1: Add failing sidecar integration tests**

In `packages/sidecar/test/session_flow.test.mjs`, add this test near the other UI session endpoint tests:

```js
test('board search groups conversation results by session and validates scope', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => {
    await shutdownCoreForTests();
    await rm(dir, { recursive: true, force: true });
  });
  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, {
    storageUri: defaultStorageTarget(homeDir).uri,
    observerProvider: undefined,
  });

  await captureTurn(makeTurnContent({
    sessionId: 'muninn/search-alpha',
    agent: 'codex_cli',
    prompt: 'board search should group by session',
    response: 'Search uses Session Top N and Top N controls.',
  }));
  await captureTurn(makeTurnContent({
    sessionId: 'lance/search-beta',
    agent: 'codex_cli',
    prompt: 'board search should also find this',
    response: 'This result belongs to a different project.',
  }));

  const response = await app.request('/api/v1/ui/search?query=board%20search&projectKey=muninn&sessionTopN=1&topN=10');
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].projectKey, 'muninn');
  assert.equal(body.results[0].sessionKey, 'muninn/search-alpha');
  assert.equal(body.results[0].items.length, 1);
  assert.equal(body.results[0].items[0].source, 'conversation');

  const invalidScope = await app.request('/api/v1/ui/search?query=board&sessionKey=muninn%2Fsearch-alpha');
  assert.equal(invalidScope.status, 400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/sidecar test -- --test-name-pattern "board search"
```

Expected: FAIL with 404 or missing route for `/api/v1/ui/search`.

- [ ] **Step 3: Wire route in app.ts**

In `packages/board/src/server/app.ts`, add `SearchResponse` to the type import and add:

```ts
import { searchBoardMemory } from './search.js';
```

Add this helper near `parseOptionalInteger`:

```ts
function parsePositiveInteger(value: string | undefined, fallback: number): number | string {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 'must be a positive integer';
}
```

Add this route before the settings routes:

```ts
boardApp.get('/api/v1/ui/search', async (c) => {
  const query = normalizeText(c.req.query('query'));
  if (!query) {
    return c.json(errorResponse('invalidRequest', 'query is required'), 400);
  }

  const rawProjectKey = normalizeText(c.req.query('projectKey'));
  const projectKey = rawProjectKey && rawProjectKey !== 'all' ? rawProjectKey : undefined;
  const rawSessionKey = normalizeText(c.req.query('sessionKey'));
  const sessionKey = rawSessionKey && rawSessionKey !== 'all' ? rawSessionKey : undefined;
  if (sessionKey && !projectKey) {
    return c.json(errorResponse('invalidRequest', 'sessionKey requires a projectKey'), 400);
  }

  const sessionTopN = parsePositiveInteger(c.req.query('sessionTopN'), 3);
  if (typeof sessionTopN === 'string') {
    return c.json(errorResponse('invalidRequest', `sessionTopN ${sessionTopN}`), 400);
  }
  const topN = parsePositiveInteger(c.req.query('topN'), 20);
  if (typeof topN === 'string') {
    return c.json(errorResponse('invalidRequest', `topN ${topN}`), 400);
  }

  const results = await searchBoardMemory({
    query,
    projectKey,
    sessionKey,
    sessionTopN,
    topN,
  }, {
    listTurns: turns.list,
    recall: memories.recall,
    getDocument: memories.get,
  });

  const response: SearchResponse = {
    results,
    requestId: generateRequestId(),
  };
  return c.json(response);
});
```

- [ ] **Step 4: Run integration test**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/sidecar test -- --test-name-pattern "board search"
```

Expected: PASS.

- [ ] **Step 5: Run server TypeScript check**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/board exec tsc -p tsconfig.server.json --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add packages/board/src/server/app.ts packages/sidecar/test/session_flow.test.mjs
git commit -m "feat: expose board search api"
```

## Task 4: Search Page Component

**Files:**
- Create: `packages/board/src/components/SearchPage.tsx`
- Modify: `packages/board/src/components/App.tsx`
- Modify: `packages/board/src/styles.css`
- Test: `packages/board/test/search-state.test.mjs`

- [ ] **Step 1: Extend state helper tests**

Append this test to `packages/board/test/search-state.test.mjs`:

```js
test('normalizeSearchN keeps positive integer select values only', async () => {
  const { normalizeSearchN } = await loadSearchState();
  assert.equal(normalizeSearchN('5', 3), 5);
  assert.equal(normalizeSearchN('0', 3), 3);
  assert.equal(normalizeSearchN('abc', 3), 3);
});
```

- [ ] **Step 2: Run helper test**

Run:

```bash
source ~/.zprofile && node --test packages/board/test/search-state.test.mjs
```

Expected: PASS if Task 1 was completed correctly.

- [ ] **Step 3: Create SearchPage component**

Create `packages/board/src/components/SearchPage.tsx`:

```tsx
import type { SearchSessionResult } from '@muninn/types';
import { ChevronDown, ChevronUp, Search } from 'lucide-react';
import { FormEvent, useMemo, useState } from 'react';
import type { BoardClient, ProjectNode } from '../lib/api.js';
import {
  DEFAULT_SESSION_TOP_N,
  DEFAULT_TOP_N,
  SEARCH_ALL_VALUE,
  buildSearchParams,
  defaultSearchControls,
  normalizeSearchN,
  sessionOptionsForProject,
  type SearchControlsState,
} from '../lib/search_state.js';
import { asErrorMessage } from '../lib/utils.js';

type SearchPageProps = {
  client: BoardClient;
  projects: ProjectNode[];
  projectsLoading: boolean;
  projectError: string | null;
  onLoadProjects: () => void;
};

const N_OPTIONS = [1, 3, 5, 10, 20];

export function SearchPage({
  client,
  projects,
  projectsLoading,
  projectError,
  onLoadProjects,
}: SearchPageProps) {
  const [controls, setControls] = useState<SearchControlsState>(() => defaultSearchControls());
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SearchSessionResult[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const sessionOptions = useMemo(
    () => sessionOptionsForProject(projects, controls.projectKey),
    [controls.projectKey, projects],
  );

  function patchControls(patch: Partial<SearchControlsState>) {
    setControls((current) => ({
      ...current,
      ...patch,
    }));
  }

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const query = controls.query.trim();
    if (!query) {
      return;
    }
    setSubmitted(true);
    setLoading(true);
    setError(null);
    setExpanded({});
    try {
      buildSearchParams(controls);
      const response = await client.search({
        query,
        projectKey: controls.projectKey,
        sessionKey: controls.sessionKey,
        sessionTopN: controls.sessionTopN,
        topN: controls.topN,
      });
      setResults(response.results);
    } catch (nextError) {
      setResults([]);
      setError(asErrorMessage(nextError));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={submitted ? 'search-page search-page-submitted' : 'search-page'}>
      <form className="search-form" onSubmit={submit}>
        <label className="search-input-shell">
          <Search />
          <input
            type="search"
            value={controls.query}
            placeholder="Search memories"
            onFocus={() => {
              if (projects.length === 0 && !projectsLoading && !projectError) {
                onLoadProjects();
              }
            }}
            onChange={(event) => patchControls({ query: event.target.value })}
          />
          <button type="submit" disabled={!controls.query.trim() || loading}>
            Search
          </button>
        </label>
        <div className="search-controls" aria-label="Search controls">
          <SearchSelect
            label="Project"
            value={controls.projectKey}
            disabled={projectsLoading}
            onChange={(value) => patchControls({ projectKey: value, sessionKey: SEARCH_ALL_VALUE })}
            options={[
              { label: 'All', value: SEARCH_ALL_VALUE },
              ...projects.map((project) => ({ label: project.label, value: project.projectKey })),
            ]}
          />
          <SearchSelect
            label="Session"
            value={controls.sessionKey}
            disabled={controls.projectKey === SEARCH_ALL_VALUE}
            onChange={(value) => patchControls({ sessionKey: value })}
            options={[
              { label: 'All', value: SEARCH_ALL_VALUE },
              ...sessionOptions,
            ]}
          />
          <SearchSelect
            label="Session Top N"
            value={String(controls.sessionTopN)}
            onChange={(value) => patchControls({ sessionTopN: normalizeSearchN(value, DEFAULT_SESSION_TOP_N) })}
            options={N_OPTIONS.map((value) => ({ label: String(value), value: String(value) }))}
          />
          <SearchSelect
            label="Top N"
            value={String(controls.topN)}
            onChange={(value) => patchControls({ topN: normalizeSearchN(value, DEFAULT_TOP_N) })}
            options={N_OPTIONS.map((value) => ({ label: String(value), value: String(value) }))}
          />
        </div>
      </form>
      {projectError ? <div className="search-error">{projectError}</div> : null}
      {submitted ? (
        <SearchResults
          loading={loading}
          error={error}
          results={results}
          expanded={expanded}
          onToggle={(id) => setExpanded((current) => ({ ...current, [id]: !current[id] }))}
        />
      ) : null}
    </div>
  );
}

function SearchSelect({
  label,
  value,
  options,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ label: string; value: string }>;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className={disabled ? 'search-control search-control-disabled' : 'search-control'}>
      <span>{label}</span>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function SearchResults({
  loading,
  error,
  results,
  expanded,
  onToggle,
}: {
  loading: boolean;
  error: string | null;
  results: SearchSessionResult[];
  expanded: Record<string, boolean>;
  onToggle: (id: string) => void;
}) {
  if (loading) {
    return <div className="search-status">Searching...</div>;
  }
  if (error) {
    return <div className="search-error">{error}</div>;
  }
  if (results.length === 0) {
    return <div className="search-status">No results found.</div>;
  }
  return (
    <div className="search-results">
      {results.map((result) => (
        <article key={result.sessionKey} className="search-result">
          <h2>{result.sessionLabel}</h2>
          <div className="search-result-meta">Project: {result.projectKey}</div>
          <div className="search-result-items">
            {result.items.map((item) => {
              const isExpanded = Boolean(expanded[item.id]);
              return (
                <section key={item.id} className="search-hit">
                  <div className="search-hit-source">Source: {item.source}</div>
                  {item.title ? <h3>{item.title}</h3> : null}
                  <div className={isExpanded ? 'search-hit-content search-hit-content-expanded' : 'search-hit-content'}>
                    {item.content}
                  </div>
                  <button className="search-hit-toggle" type="button" onClick={() => onToggle(item.id)}>
                    {isExpanded ? <ChevronUp /> : <ChevronDown />}
                    <span>{isExpanded ? 'Collapse' : 'Expand'}</span>
                  </button>
                </section>
              );
            })}
          </div>
        </article>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Wire SearchPage in App**

In `packages/board/src/components/App.tsx`, import:

```ts
import { SearchPage } from './SearchPage.js';
```

Replace the non-settings branch with:

```tsx
{route.view === 'settings' ? (
  <SettingsPage client={client} />
) : route.view === 'search' ? (
  <SearchPage
    client={client}
    projects={projects}
    projectsLoading={projectLoading}
    projectError={projectError}
    onLoadProjects={loadProjects}
  />
) : (
  <EmptyView view={route.view} />
)}
```

Keep `EmptyView` for `wiki` only.

- [ ] **Step 5: Add CSS**

Append to `packages/board/src/styles.css`:

```css
.search-page {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 28vh 28px 48px;
}

.search-page-submitted {
  align-items: stretch;
  padding-top: 36px;
}

.search-form {
  width: min(820px, 100%);
  margin: 0 auto;
}

.search-input-shell {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 54px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
  padding: 0 8px 0 16px;
  box-shadow: 0 10px 30px rgba(18, 20, 24, 0.06);
}

.search-input-shell svg {
  width: 18px;
  height: 18px;
  color: var(--text-muted);
}

.search-input-shell input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  font: inherit;
  color: var(--text);
}

.search-input-shell button {
  height: 36px;
  border: 0;
  border-radius: 6px;
  padding: 0 12px;
  background: #1f2328;
  color: #fff;
  font: inherit;
}

.search-input-shell button:disabled {
  opacity: 0.45;
}

.search-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
  color: var(--text-muted);
  font-size: 12px;
}

.search-control {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: #f7f7f7;
  padding: 0 8px;
}

.search-control select {
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  outline: 0;
}

.search-control-disabled {
  opacity: 0.5;
}

.search-results {
  width: min(920px, 100%);
  margin: 28px auto 0;
}

.search-result {
  padding: 18px 0;
  border-bottom: 1px solid var(--border);
}

.search-result h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0;
}

.search-result-meta,
.search-hit-source {
  margin-top: 4px;
  color: var(--text-subtle);
  font-size: 12px;
}

.search-result-items {
  display: grid;
  gap: 12px;
  margin-top: 12px;
}

.search-hit h3 {
  margin: 6px 0 4px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0;
}

.search-hit-content {
  max-height: 96px;
  overflow: hidden;
  white-space: pre-wrap;
  color: var(--text);
  line-height: 1.55;
}

.search-hit-content-expanded {
  max-height: none;
}

.search-hit-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
  border: 0;
  background: transparent;
  color: var(--text-muted);
  padding: 0;
  font: inherit;
}

.search-hit-toggle svg {
  width: 14px;
  height: 14px;
}

.search-status,
.search-error {
  width: min(920px, 100%);
  margin: 28px auto 0;
  color: var(--text-muted);
}

.search-error {
  color: var(--danger);
}
```

- [ ] **Step 6: Run client checks**

Run:

```bash
source ~/.zprofile && node --test packages/board/test/search-state.test.mjs
source ~/.zprofile && pnpm --filter @muninn/board exec tsc -p tsconfig.json --noEmit
```

Expected: both commands PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add packages/board/src/components/SearchPage.tsx packages/board/src/components/App.tsx packages/board/src/styles.css packages/board/test/search-state.test.mjs
git commit -m "feat: add board search page"
```

## Task 5: End-To-End Validation And Visual Check

**Files:**
- Modify only files needed to fix failures found by this task.

- [ ] **Step 1: Run focused tests**

Run:

```bash
source ~/.zprofile && node --test packages/board/test/search-state.test.mjs packages/board/test/search-server.test.mjs
source ~/.zprofile && pnpm --filter @muninn/sidecar test -- --test-name-pattern "board search"
```

Expected: PASS.

- [ ] **Step 2: Run Board TypeScript checks**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/board exec tsc -p tsconfig.json --noEmit
source ~/.zprofile && pnpm --filter @muninn/board exec tsc -p tsconfig.server.json --noEmit
```

Expected: PASS.

- [ ] **Step 3: Run full relevant package tests**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/board build
source ~/.zprofile && pnpm --filter @muninn/sidecar test
```

Expected: PASS. If unrelated pre-existing failures appear, capture the exact failing test names and run the focused passing checks from Steps 1 and 2 again before reporting.

- [ ] **Step 4: Start local Board server**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/board dev
```

Expected: the dev command starts or watches without TypeScript errors. Keep the session running only long enough to inspect Search if the implementation environment supports Browser verification.

- [ ] **Step 5: Browser visual verification**

Use the Browser plugin to open the Board URL used by the local dev server. Verify:

- `#/search?demo=1` or the equivalent demo URL shows the centered initial search state.
- Project, Session, `Session Top N`, and `Top N` controls are visible under the input.
- `Session` is disabled while `Project` is `All`.
- Searching a demo query moves the input to the top and renders session-grouped results.
- Each hit item shows one `Source` label and supports expand/collapse.

- [ ] **Step 6: Final commit if fixes were needed**

If Step 1 through Step 5 required fixes after the Task 4 commit, run:

```bash
git add packages/types/src/api.ts packages/board/src packages/board/test packages/sidecar/test/session_flow.test.mjs
git commit -m "fix: stabilize board search"
```

Expected: a commit is created only if this task changed files.

## Self-Review

Spec coverage:

- Search empty state replacement: Task 4.
- `#/search` route retained: Task 4 modifies `App.tsx` without changing route parsing.
- Board UI search API: Task 3.
- Unified result shape: Task 1 types and Task 2 grouping.
- Project/session request scope: Task 2 and Task 3.
- Session result rendering: Task 4.
- Per-item source labels: Task 4.
- Fixed preview height and expand/collapse: Task 4.
- Demo data: Task 1.
- No generated answer/right pane/edit workflow: no task introduces those surfaces.

Placeholder scan:

- This plan contains no unresolved placeholders or unspecified test steps.

Type consistency:

- UI labels use exact `Session Top N` and `Top N`.
- API params use `sessionTopN` and `topN`.
- Result types use `SearchResponse`, `SearchSessionResult`, `SearchResultItem`, and `SearchResultLink` consistently.
