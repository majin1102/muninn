# Board Extraction Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Session content split view with snapshot-derived Observation accordion content on the left and Conversation on the right, plus three floating view-mode icons and a full-height draggable divider.

**Architecture:** Extend the Session turns API to return snapshot-derived observations alongside existing `turns` and `segments`. Add focused client-side types and a `SessionContentSplit` container that owns the split mode, resize state, and selected observation state while keeping `ChatView` responsible only for conversation rendering. Use the existing snapshot extraction parsing path as the source of truth for both third-level tree segments and the Observation pane.

**Tech Stack:** TypeScript, React, Vite, `react-markdown`, `remark-gfm`, Hono board server, Node test runner.

---

## File Structure

- Modify `packages/types/src/api.ts`
  - Add `ExtractionPreview`.
  - Add `observations` to `SessionTurnsResponse`.
- Modify `packages/board/src/server/app.ts`
  - Parse snapshot extraction blocks into rich observation previews.
  - Keep existing `segments` as the lightweight tree view.
  - Export test helpers for observation parsing.
- Modify `packages/board/src/lib/api.ts`
  - Add `ProjectObservationNode`.
  - Store `observations` on `ProjectSessionNode`.
  - Map API/demo observations into project/session context.
- Modify `packages/board/src/demo/provider.ts`
  - Return demo observations for local demo mode.
- Modify `packages/board/src/components/App.tsx`
  - Replace direct `ChatView` usage with `SessionContentSplit`.
  - Own active session, active memory id, mode, and load-more callbacks.
- Create `packages/board/src/components/SessionContentSplit.tsx`
  - Own content mode controls, split resize, selected observation expansion, and layout.
  - Render `ObservationPane` and `ChatView`.
- Create `packages/board/src/components/ObservationPane.tsx`
  - Render session summary and snapshot observation soft accordion.
  - Markdown render each observation body.
- Modify `packages/board/src/styles.css`
  - Add split content layout, floating mode icon buttons, full-height divider, transitions, and observation Markdown styles.
- Modify `packages/board/test/session-segments.test.mjs`
  - Add parser tests for rich observations and fallback behavior.
- Create `packages/board/test/session-content-state.test.mjs`
  - Add pure reducer/helper tests for view-mode transitions and split-width constraints.

## Task 1: Extend API Types For Snapshot Observations

**Files:**
- Modify: `packages/types/src/api.ts`
- Modify: `packages/board/src/lib/api.ts`

- [ ] **Step 1: Add a failing type usage in `packages/board/src/lib/api.ts`**

Add the import and type references before the server implementation exists:

```ts
import type {
  AgentNode,
  CodexImportPreviewResponse,
  CodexImportRunResponse,
  ErrorResponse,
  MemoryDocument,
  MemoryDocumentResponse,
  SessionAgentsResponse,
  SessionGroupsResponse,
  SessionNode,
  ExtractionPreview,
  SessionSegmentPreview,
  SessionTurnsResponse,
  SettingsConfigResponse,
  TurnPreview,
} from '@muninn/types';

export type ProjectObservationNode = ExtractionPreview & {
  agent: string;
  sessionKey: string;
  sessionLabel: string;
};

export type ProjectSessionNode = SessionNode & {
  agent: string;
  turns: ProjectTurnNode[];
  segments: ProjectSegmentNode[];
  observations: ProjectObservationNode[];
  nextOffset: number | null;
  loading: boolean;
  loaded: boolean;
};
```

- [ ] **Step 2: Run typecheck to verify it fails**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/board build
```

Expected: `tsc` fails because `ExtractionPreview` does not exist and project session initialization is missing `observations`.

- [ ] **Step 3: Add API type definitions**

In `packages/types/src/api.ts`, add:

```ts
export interface ExtractionPreview {
  memoryId: string;
  title: string;
  createdAt: string;
  markdown: string;
  refs: string[];
}
```

Update `SessionTurnsResponse`:

```ts
export interface SessionTurnsResponse {
  turns: TurnPreview[];
  segments: SessionSegmentPreview[];
  observations: ExtractionPreview[];
  nextOffset: number | null;
  requestId: string;
}
```

- [ ] **Step 4: Wire client mapping minimally**

In `packages/board/src/lib/api.ts`, initialize session objects with `observations: []`:

```ts
project.sessions.push({
  ...session,
  agent: agent.agent,
  turns: [],
  segments: [],
  observations: [],
  nextOffset: null,
  loading: false,
  loaded: false,
});
```

Map loaded observations:

```ts
observations: (response.observations ?? []).map((observation) => ({
  ...observation,
  agent: session.agent,
  sessionKey: session.sessionKey,
  sessionLabel: session.displaySessionId,
})),
```

Use that mapping in both demo and non-demo `loadSessionTurns()` paths.

- [ ] **Step 5: Run typecheck again**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/board build
```

Expected: remaining failures point to server/demo missing `observations`.

## Task 2: Parse Snapshot Extraction Blocks Into Observation Previews

**Files:**
- Modify: `packages/board/src/server/app.ts`
- Modify: `packages/board/test/session-segments.test.mjs`

- [ ] **Step 1: Add failing parser tests**

In `packages/board/test/session-segments.test.mjs`, extend the import:

```js
import {
  buildExtractionsForTests,
  buildSessionSegmentsForTests,
  buildSessionTurnPageForTests,
  resolveSessionTreeNextOffsetForTests,
  resolveSessionNodeFromIndexForTests,
} from '../dist-server/app.js';
```

Add:

```js
test('builds snapshot observations with markdown and refs', () => {
  const snapshot = [
    '# Session title',
    '',
    '## Summary',
    'Session summary text',
    '',
    '## Extractions',
    '<!-- sequence: 1; refs: [turn:1, turn:2] -->',
    '### Title',
    'Prompt budget rules',
    '',
    '### Summary',
    'Summary content.',
    '',
    '### Content',
    '- Keep Markdown bullets.',
    '----',
    '<!-- refs: [turn:2] -->',
    '### Title',
    'Title language',
    '',
    '### Summary',
    'Write in the session language.',
  ].join('\n');

  assert.deepEqual(buildExtractionsForTests(snapshot, turns), [
    {
      memoryId: 'turn:1',
      title: 'Prompt budget rules',
      createdAt: '2026-06-02T10:00:00.000Z',
      markdown: ['### Summary', 'Summary content.', '', '### Content', '- Keep Markdown bullets.'].join('\n'),
      refs: ['turn:1', 'turn:2'],
    },
    {
      memoryId: 'turn:2',
      title: 'Title language',
      createdAt: '2026-06-02T10:10:00.000Z',
      markdown: ['### Summary', 'Write in the session language.'].join('\n'),
      refs: ['turn:2'],
    },
  ]);
});

test('session turn page includes observations when snapshot content is usable', async () => {
  const snapshot = [
    '## Extractions',
    '<!-- refs: [turn:1] -->',
    '### Title',
    'Segment title',
    '',
    '### Summary',
    'Segment summary.',
  ].join('\n');

  const page = await buildSessionTurnPageForTests({
    turns,
    snapshotContent: snapshot,
    offset: 0,
    limit: 1,
  });

  assert.equal(page.observations.length, 1);
  assert.equal(page.observations[0].title, 'Segment title');
  assert.equal(page.observations[0].memoryId, 'turn:1');
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/board build && node --test packages/board/test/session-segments.test.mjs
```

Expected: build or test fails because `buildExtractionsForTests` and `observations` are not implemented.

- [ ] **Step 3: Implement observation parsing**

In `packages/board/src/server/app.ts`, add an observation builder next to `buildSessionSegments()`:

```ts
function buildExtractions(
  snapshotContent: string | null | undefined,
  turnPreviews: TurnPreview[],
): ExtractionPreview[] {
  if (!snapshotContent) {
    return [];
  }
  return parseSnapshotExtractionBlocks(snapshotContent, turnPreviews);
}
```

Add block parsing:

```ts
function parseSnapshotExtractionBlocks(
  snapshotContent: string,
  turnPreviews: TurnPreview[],
): ExtractionPreview[] {
  const extractionStart = snapshotContent.search(/^##\s+Extractions\s*$/im);
  if (extractionStart < 0) {
    return [];
  }
  const sectionStart = snapshotContent.indexOf('\n', extractionStart);
  if (sectionStart < 0) {
    return [];
  }
  const rest = snapshotContent.slice(sectionStart + 1);
  const nextSection = rest.search(/^##\s+/m);
  const section = nextSection >= 0 ? rest.slice(0, nextSection) : rest;
  const turnById = new Map(turnPreviews.map((turn, index) => [turn.memoryId, { turn, index }]));
  const refsPattern = /<!--\s*(?:sequence:\s*\d+\s*;\s*)?refs:\s*\[([^\]]*)\]\s*-->/g;
  const matches = [...section.matchAll(refsPattern)];
  const observations: Array<ExtractionPreview & { index: number }> = [];

  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]!;
    const next = matches[i + 1];
    const block = section.slice(match.index! + match[0].length, next?.index ?? section.length).trim();
    const refs = parseExtractionRefs(match[1]);
    const firstTurn = refs.map((ref) => turnById.get(ref)).find((entry) => entry !== undefined);
    if (!firstTurn) {
      continue;
    }
    const title = normalizeSegmentTitle(block);
    if (!title) {
      continue;
    }
    const markdown = normalizeObservationMarkdown(block);
    observations.push({
      memoryId: firstTurn.turn.memoryId,
      title,
      createdAt: firstTurn.turn.createdAt,
      markdown,
      refs,
      index: firstTurn.index,
    });
  }

  return observations
    .sort((left, right) => (
      left.createdAt.localeCompare(right.createdAt)
      || left.index - right.index
    ))
    .map(({ index: _index, ...observation }) => observation);
}
```

Add title-stripped Markdown rendering:

```ts
function normalizeObservationMarkdown(block: string): string {
  const withoutTitle = block.replace(
    /(?:^|\n)###\s+Title\s*\n[\s\S]*?(?=\n###\s+|^\s*----\s*$|\s*$)/im,
    '',
  );
  return withoutTitle
    .replace(/^\s*----\s*$/gm, '')
    .trim();
}
```

- [ ] **Step 4: Return observations from page builder**

Update return type of `buildSessionTurnPage()` and `loadSessionTurnPreviewsPage()` to include `observations`.

Inside `buildSessionTurnPage()`:

```ts
const observations = buildExtractions(params.snapshotContent, params.turns);
return {
  turns: pageTurns,
  segments,
  observations,
  nextOffset: resolveSessionTreeNextOffset({
    segmentCount: segments.length,
    offset: params.offset,
    limit: params.limit,
    turnCount: params.turns.length,
  }),
};
```

In route response:

```ts
const response: SessionTurnsResponse = {
  turns: page.turns,
  segments: page.segments,
  observations: page.observations,
  nextOffset: page.nextOffset,
  requestId: generateRequestId(),
};
```

Export test helper:

```ts
export function buildExtractionsForTests(
  snapshotContent: string | null | undefined,
  turnPreviews: TurnPreview[],
): ExtractionPreview[] {
  return buildExtractions(snapshotContent, turnPreviews);
}
```

- [ ] **Step 5: Run parser tests**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/board build && node --test packages/board/test/session-segments.test.mjs
```

Expected: all session segment tests pass.

## Task 3: Add Demo And Client Observation Data Flow

**Files:**
- Modify: `packages/board/src/demo/provider.ts`
- Modify: `packages/board/src/lib/api.ts`
- Modify: `packages/board/src/components/App.tsx`

- [ ] **Step 1: Add demo observations**

In `packages/board/src/demo/provider.ts`, update the return shape:

```ts
return {
  turns: page,
  segments: turns.map((turn) => ({
    memoryId: turn.memoryId,
    title: turn.prompt ?? turn.summary,
    createdAt: turn.createdAt,
  })),
  observations: turns.slice(0, 4).map((turn) => ({
    memoryId: turn.memoryId,
    title: turn.prompt ?? turn.summary,
    createdAt: turn.createdAt,
    markdown: [
      '### Summary',
      turn.summary,
      '',
      '### Content',
      '- Demo observation content rendered as Markdown.',
      '- It follows the same soft accordion behavior as imported snapshots.',
    ].join('\n'),
    refs: [turn.memoryId],
  })),
  nextOffset: offset + limit < turns.length ? offset + limit : null,
};
```

- [ ] **Step 2: Wire `App` session updates**

In `openSession()` update:

```ts
updateSession(session, {
  turns: response.turns,
  segments: response.segments,
  observations: response.observations,
  nextOffset: response.nextOffset,
  loading: false,
  loaded: true,
});
```

In `loadMore()` update:

```ts
updateSession(session, {
  turns: [...session.turns, ...response.turns],
  segments: response.segments.length > 0 ? response.segments : session.segments,
  observations: response.observations.length > 0 ? response.observations : session.observations,
  nextOffset: response.nextOffset,
  loading: false,
  loaded: true,
});
```

- [ ] **Step 3: Ensure client mapping returns observations**

In `packages/board/src/lib/api.ts`, return from `loadSessionTurns()`:

```ts
return {
  turns: response.turns.map((turn) => ({
    ...turn,
    agent: session.agent,
    sessionKey: session.sessionKey,
    sessionLabel: session.displaySessionId,
  })),
  segments: (response.segments ?? []).map((segment) => ({
    ...segment,
    agent: session.agent,
    sessionKey: session.sessionKey,
    sessionLabel: session.displaySessionId,
  })),
  observations: (response.observations ?? []).map((observation) => ({
    ...observation,
    agent: session.agent,
    sessionKey: session.sessionKey,
    sessionLabel: session.displaySessionId,
  })),
  nextOffset: response.nextOffset,
};
```

- [ ] **Step 4: Run build**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/board build
```

Expected: board build passes.

## Task 4: Add Split View State Helpers

**Files:**
- Create: `packages/board/src/lib/session_content_state.ts`
- Create: `packages/board/test/session-content-state.test.mjs`

- [ ] **Step 1: Write failing state tests**

Create `packages/board/test/session-content-state.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampObservationWidth,
  nextSessionContentMode,
} from '../dist/lib/session_content_state.js';

test('clamps observation split width to pane constraints', () => {
  assert.equal(clampObservationWidth({ requested: 100, containerWidth: 1200 }), 320);
  assert.equal(clampObservationWidth({ requested: 500, containerWidth: 1200 }), 500);
  assert.equal(clampObservationWidth({ requested: 1000, containerWidth: 1200 }), 680);
});

test('switches among mutually exclusive content modes', () => {
  assert.equal(nextSessionContentMode('split', 'observation'), 'observation');
  assert.equal(nextSessionContentMode('observation', 'split'), 'split');
  assert.equal(nextSessionContentMode('split', 'conversation'), 'conversation');
  assert.equal(nextSessionContentMode('conversation', 'split'), 'split');
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/board build && node --test packages/board/test/session-content-state.test.mjs
```

Expected: build fails because `session_content_state.ts` does not exist.

- [ ] **Step 3: Implement state helpers**

Create `packages/board/src/lib/session_content_state.ts`:

```ts
export type SessionContentMode = 'observation' | 'split' | 'conversation';

export const OBSERVATION_MIN_WIDTH = 320;
export const CONVERSATION_MIN_WIDTH = 520;
export const DEFAULT_OBSERVATION_WIDTH = 420;

export function clampObservationWidth({
  requested,
  containerWidth,
}: {
  requested: number;
  containerWidth: number;
}): number {
  const maxWidth = Math.max(OBSERVATION_MIN_WIDTH, containerWidth - CONVERSATION_MIN_WIDTH);
  return Math.min(Math.max(requested, OBSERVATION_MIN_WIDTH), maxWidth);
}

export function nextSessionContentMode(
  _current: SessionContentMode,
  requested: SessionContentMode,
): SessionContentMode {
  return requested;
}
```

- [ ] **Step 4: Run helper tests**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/board build && node --test packages/board/test/session-content-state.test.mjs
```

Expected: helper tests pass.

## Task 5: Build Observation Pane Components

**Files:**
- Create: `packages/board/src/components/ObservationPane.tsx`
- Modify: `packages/board/src/styles.css`

- [ ] **Step 1: Create ObservationPane component**

Create `packages/board/src/components/ObservationPane.tsx`:

```tsx
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ProjectObservationNode } from '../lib/api.js';

export function ObservationPane({
  observations,
  activeMemoryId,
}: {
  observations: ProjectObservationNode[];
  activeMemoryId: string | null;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const itemRefs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    if (!activeMemoryId || !observations.some((item) => item.memoryId === activeMemoryId)) {
      return;
    }
    setExpanded((current) => new Set(current).add(activeMemoryId));
    window.requestAnimationFrame(() => {
      itemRefs.current.get(activeMemoryId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }, [activeMemoryId, observations]);

  if (observations.length === 0) {
    return (
      <div className="observation-empty">
        No observations for this session yet.
      </div>
    );
  }

  return (
    <div className="observation-pane-content">
      {observations.map((observation) => {
        const isExpanded = expanded.has(observation.memoryId);
        const isActive = activeMemoryId === observation.memoryId;
        return (
          <div
            key={`${observation.memoryId}:${observation.title}`}
            ref={(node) => {
              if (node) {
                itemRefs.current.set(observation.memoryId, node);
              } else {
                itemRefs.current.delete(observation.memoryId);
              }
            }}
            className={isActive ? 'observation-item observation-item-active' : 'observation-item'}
          >
            <button
              className="observation-item-header"
              type="button"
              aria-expanded={isExpanded}
              onClick={() => {
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(observation.memoryId)) {
                    next.delete(observation.memoryId);
                  } else {
                    next.add(observation.memoryId);
                  }
                  return next;
                });
              }}
            >
              <ChevronRight className={isExpanded ? 'observation-chevron observation-chevron-open' : 'observation-chevron'} />
              <span>{observation.title}</span>
            </button>
            {isExpanded ? (
              <div className="observation-markdown markdown-content">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {observation.markdown || '### Summary\nNo detail available.'}
                </ReactMarkdown>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Add observation styles**

Append to `packages/board/src/styles.css`:

```css
.observation-pane-content {
  min-width: 0;
  height: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 72px 28px 24px;
  scrollbar-color: transparent transparent;
  scrollbar-width: thin;
}

.observation-pane-content:hover {
  scrollbar-color: var(--scrollbar-thumb-hover) transparent;
}

.observation-empty {
  padding: 72px 28px 24px;
  color: var(--muted-foreground);
  font-size: 14px;
}

.observation-item {
  border-radius: 8px;
}

.observation-item-active,
.observation-item:has(.observation-item-header[aria-expanded="true"]) {
  background: #f6f7f8;
}

.observation-item-header {
  width: 100%;
  min-width: 0;
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  padding: 11px 12px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #2b2f36;
  font: inherit;
  font-weight: 560;
  text-align: left;
  cursor: pointer;
}

.observation-chevron {
  width: 14px;
  height: 14px;
  color: #7b8492;
  transition: transform 140ms ease;
}

.observation-chevron-open {
  transform: rotate(90deg);
}

.observation-markdown {
  padding: 0 14px 14px 36px;
  color: #3e434b;
  font-size: 13px;
  line-height: 1.55;
}

.observation-markdown pre,
.observation-markdown table {
  max-width: 100%;
  overflow-x: auto;
}
```

- [ ] **Step 3: Run build**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/board build
```

Expected: build passes.

## Task 6: Build SessionContentSplit Container

**Files:**
- Create: `packages/board/src/components/SessionContentSplit.tsx`
- Modify: `packages/board/src/components/App.tsx`
- Modify: `packages/board/src/styles.css`

- [ ] **Step 1: Create split container**

Create `packages/board/src/components/SessionContentSplit.tsx`:

```tsx
import type { MemoryDocument } from '@muninn/types';
import { useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { clampObservationWidth, DEFAULT_OBSERVATION_WIDTH, type SessionContentMode } from '../lib/session_content_state.js';
import type { ProjectObservationNode, ProjectTurnNode } from '../lib/api.js';
import { ChatView } from './ChatView.js';
import { ObservationPane } from './ObservationPane.js';

export function SessionContentSplit({
  title,
  observations,
  document,
  activeMemoryId,
  sessionTurns,
  canLoadMoreAfter,
  loadingMoreAfter,
  onLoadMoreAfter,
  loading,
  error,
}: {
  title: string;
  observations: ProjectObservationNode[];
  document: MemoryDocument | null;
  activeMemoryId: string | null;
  sessionTurns: ProjectTurnNode[];
  canLoadMoreAfter: boolean;
  loadingMoreAfter: boolean;
  onLoadMoreAfter: () => void;
  loading: boolean;
  error: string | null;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<SessionContentMode>('split');
  const [observationWidth, setObservationWidth] = useState(DEFAULT_OBSERVATION_WIDTH);

  function startResize(event: PointerEvent<HTMLButtonElement>) {
    if (mode !== 'split') {
      return;
    }
    const shell = shellRef.current;
    if (!shell) {
      return;
    }
    event.preventDefault();
    const resize = (clientX: number) => {
      const rect = shell.getBoundingClientRect();
      setObservationWidth(clampObservationWidth({
        requested: clientX - rect.left,
        containerWidth: rect.width,
      }));
    };
    const onPointerMove = (moveEvent: globalThis.PointerEvent) => resize(moveEvent.clientX);
    const cleanup = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', cleanup, { once: true });
    window.addEventListener('pointercancel', cleanup, { once: true });
  }

  return (
    <div
      ref={shellRef}
      className={`session-content-split session-content-mode-${mode}`}
      style={{ '--observation-width': `${observationWidth}px` } as CSSProperties}
    >
      <div className="session-content-title">{title}</div>
      <div className="session-content-mode-controls" aria-label="Session content mode">
        <ModeButton mode="observation" active={mode === 'observation'} label="Observation only" onClick={() => setMode('observation')} />
        <ModeButton mode="split" active={mode === 'split'} label="Split view" onClick={() => setMode('split')} />
        <ModeButton mode="conversation" active={mode === 'conversation'} label="Conversation only" onClick={() => setMode('conversation')} />
      </div>
      <section className="extraction-pane" aria-label="Session observations">
        <ObservationPane observations={observations} activeMemoryId={activeMemoryId} />
      </section>
      {mode === 'split' ? (
        <button className="session-content-divider" type="button" aria-label="Resize observation and conversation panes" onPointerDown={startResize} />
      ) : null}
      <section className="session-conversation-pane" aria-label="Session conversation">
        <ChatView
          document={document}
          activeMemoryId={activeMemoryId}
          sessionTurns={sessionTurns}
          canLoadMoreAfter={canLoadMoreAfter}
          loadingMoreAfter={loadingMoreAfter}
          onLoadMoreAfter={onLoadMoreAfter}
          loading={loading}
          error={error}
        />
      </section>
    </div>
  );
}

function ModeButton({
  mode,
  active,
  label,
  onClick,
}: {
  mode: SessionContentMode;
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={active ? 'session-mode-button session-mode-button-active' : 'session-mode-button'}
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
    >
      <span className={`session-mode-glyph session-mode-glyph-${mode}`} aria-hidden="true" />
    </button>
  );
}
```

- [ ] **Step 2: Replace ChatView usage in App**

In `packages/board/src/components/App.tsx`, import:

```ts
import { SessionContentSplit } from './SessionContentSplit.js';
```

Replace the existing `<section className="conversation-pane">...</section>` block with:

```tsx
<section className="conversation-pane">
  <SessionContentSplit
    title={activeSession?.displaySessionId ?? document?.title ?? 'Session'}
    observations={activeSession?.observations ?? []}
    document={document}
    activeMemoryId={route.memoryId}
    sessionTurns={activeSessionTurns}
    canLoadMoreAfter={Boolean(activeSession && activeSession.nextOffset !== null)}
    loadingMoreAfter={activeSession?.loading ?? false}
    onLoadMoreAfter={() => {
      if (activeSession) {
        void loadMore(activeSession);
      }
    }}
    loading={documentLoading || locatingActiveTurn}
    error={documentError}
  />
</section>
```

Remove the direct `ChatView` import from `App.tsx`.

- [ ] **Step 3: Add split layout styles**

Append to `packages/board/src/styles.css`:

```css
.session-content-split {
  --observation-width: 420px;
  position: relative;
  min-width: 0;
  min-height: 0;
  width: 100%;
  height: 100%;
  display: grid;
  grid-template-columns: minmax(320px, var(--observation-width)) 1px minmax(0, 1fr);
  background: var(--card);
  overflow: hidden;
  transition: grid-template-columns 160ms ease;
}

.session-content-title {
  position: absolute;
  top: 24px;
  left: 28px;
  z-index: 4;
  max-width: calc(100% - 180px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--foreground);
  font-size: 20px;
  font-weight: 650;
}

.session-content-mode-controls {
  position: absolute;
  top: 18px;
  right: 28px;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 10px;
}

.session-mode-button {
  width: 32px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #5d6673;
  transition: background-color 120ms ease, color 120ms ease;
}

.session-mode-button:hover,
.session-mode-button:focus-visible,
.session-mode-button-active {
  background: #f2f4f7;
  color: #20242a;
}

.session-mode-glyph {
  width: 17px;
  height: 14px;
  border: 1.7px solid currentColor;
  border-radius: 3px;
  position: relative;
}

.session-mode-glyph::after {
  content: "";
  position: absolute;
  top: 2px;
  bottom: 2px;
  border-left: 1.7px solid currentColor;
}

.session-mode-glyph-observation::after {
  left: 3px;
}

.session-mode-glyph-split::after {
  left: 50%;
  transform: translateX(-50%);
}

.session-mode-glyph-conversation::after {
  right: 3px;
}

.extraction-pane {
  min-width: 0;
  min-height: 0;
  opacity: 1;
  overflow: hidden;
  transition: opacity 160ms ease;
}

.session-conversation-pane {
  min-width: 0;
  min-height: 0;
  opacity: 1;
  overflow: hidden;
  transition: opacity 160ms ease;
}

.session-content-divider {
  z-index: 3;
  width: 1px;
  height: 100%;
  padding: 0;
  border: 0;
  background: var(--border);
  cursor: col-resize;
}

.session-content-divider:hover,
.session-content-divider:focus-visible,
.session-content-divider:active {
  background: #c9cdd3;
}

.session-content-mode-observation {
  grid-template-columns: minmax(0, 1fr) 0 0;
}

.session-content-mode-observation .session-conversation-pane,
.session-content-mode-observation .session-content-divider {
  opacity: 0;
  pointer-events: none;
  visibility: hidden;
}

.session-content-mode-conversation {
  grid-template-columns: 0 0 minmax(0, 1fr);
}

.session-content-mode-conversation .extraction-pane,
.session-content-mode-conversation .session-content-divider {
  opacity: 0;
  pointer-events: none;
  visibility: hidden;
}

@media (prefers-reduced-motion: reduce) {
  .session-content-split,
  .session-mode-button,
  .extraction-pane,
  .session-conversation-pane,
  .observation-chevron {
    transition: none;
  }
}
```

- [ ] **Step 4: Run build**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/board build
```

Expected: board build passes.

## Task 7: Align Tree Clicks And Conversation Loading

**Files:**
- Modify: `packages/board/src/components/App.tsx`
- Modify: `packages/board/src/components/SessionTree.tsx` if needed.

- [ ] **Step 1: Keep second-level session click in overview state**

In `SessionTree`, keep `onOpenSession(session)` behavior unchanged for second-level session clicks. Confirm it does not set `window.location.hash` to a turn when clicking session headers.

Expected code remains:

```tsx
onOpenSession={openSession}
onOpenTurn={(memoryId) => {
  window.location.hash = `#/session/${encodeURIComponent(memoryId)}`;
}}
```

- [ ] **Step 2: Ensure active observation can load more turns**

Keep the existing effects in `App.tsx` that load more session turns when `route.memoryId` is not found. Verify this still works after `SessionContentSplit` replacement because `activeSessionTurns` and `activeTurnSession` are unchanged.

No code change should be required if Task 6 passed.

- [ ] **Step 3: Run session tree tests**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/board build && node --test packages/board/test/session-segments.test.mjs
```

Expected: session tree parsing and pagination tests pass.

## Task 8: Verification And Manual Browser Check

**Files:**
- No code files unless previous tasks reveal defects.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/board build
node --test packages/board/test/session-segments.test.mjs
node --test packages/board/test/session-content-state.test.mjs
```

Expected: all commands pass.

- [ ] **Step 2: Restart or refresh local Board**

If sidecar on `8090` is still running and serving this worktree, rebuild is enough. Otherwise start it:

```bash
source ~/.zprofile && MUNINN_HOME=$PWD/.muninn PORT=8090 pnpm --filter @muninn/sidecar start
```

Expected: `/health` returns `{"status":"ok",...}`.

- [ ] **Step 3: Browser verification**

Open:

```text
http://localhost:8090/board/?time=all#/session
```

Verify manually:

- Clicking a second-level session shows split mode by default.
- Left pane shows collapsed observation accordion items.
- Right pane shows the conversation.
- Clicking a third-level segment expands the matching observation.
- The conversation scrolls to or loads toward the referenced turn.
- The mode icons switch Observation-only, Split, and Conversation-only.
- Split mode shows a full-height draggable divider.
- Single-pane modes hide the divider.
- Pane labels `Observation` and `Conversation` are not shown.
- Mode transitions feel restrained and do not fight reading.

- [ ] **Step 4: Commit implementation**

Commit only files changed by this implementation:

```bash
git add packages/types/src/api.ts \
  packages/board/src/server/app.ts \
  packages/board/src/lib/api.ts \
  packages/board/src/demo/provider.ts \
  packages/board/src/components/App.tsx \
  packages/board/src/components/SessionContentSplit.tsx \
  packages/board/src/components/ObservationPane.tsx \
  packages/board/src/lib/session_content_state.ts \
  packages/board/src/styles.css \
  packages/board/test/session-segments.test.mjs \
  packages/board/test/session-content-state.test.mjs
git commit -m "feat: add extraction split view"
```

Expected: commit succeeds and does not include unrelated schema/extractor work.

## Self-Review

Spec coverage:

- Snapshot-derived Observation source: Task 2.
- Observation left / Conversation right split: Task 6.
- Three floating mode icons: Task 6.
- Full-height draggable divider: Task 6.
- Single-pane modes: Task 4 and Task 6.
- No pane titles and no horizontal separator: Task 6 CSS.
- Session click overview with collapsed observations: Task 5 and Task 7.
- Segment click expands observation and targets first ref: Task 5 and existing route behavior verified in Task 7.
- Markdown rendering and overflow control: Task 5.
- Tests and manual verification: Task 8.

Placeholder scan:

- This plan contains no placeholder markers or unspecified generic cleanup steps.

Type consistency:

- `ExtractionPreview` is the API type.
- `ProjectObservationNode` is the client-enriched type.
- `SessionContentMode` is the UI mode type.
- `observations` is consistently added to session responses and project session nodes.
