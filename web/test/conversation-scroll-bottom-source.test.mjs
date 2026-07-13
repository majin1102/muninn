import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('conversation toolbar places the scroll-to-bottom button between locate and layout controls', async () => {
  const source = await readFile(new URL('../src/components/SessionContentSplit.tsx', import.meta.url), 'utf8');

  assert.match(source, /import \{ LocateIcon, ScrollToBottomIcon \} from '\.\/icons\.js';/);
  assert.match(source, /aria-label="Go to latest conversation content"/);
  assert.match(source, /onLocateConversationEnd\(\)/);
  assert.match(source, /setScrollToBottomContextId\(contextId\);\s*setScrollToBottomRequestId\(\(current\) => current \+ 1\);/);
  assert.match(
    source,
    /\{locateConversationButton\}\s*\{scrollToBottomButton\}\s*\{modeButton\}/,
  );
  assert.match(source, /scrollToBottomRequestId=\{scrollToBottomRequestId\}/);
  assert.match(source, /scrollToBottomContextId=\{scrollToBottomContextId\}/);
});

test('conversation scroll waits for the latest turn and scrolls the viewport to its bottom', async () => {
  const source = await readFile(new URL('../src/components/ChatView.tsx', import.meta.url), 'utf8');

  assert.match(source, /handledScrollToBottomRequestRef = useRef\(0\)/);
  assert.match(source, /row\.dataset\.contextId === scrollToBottomContextId/);
  assert.match(source, /handledScrollToBottomRequestRef\.current = scrollToBottomRequestId/);
  assert.match(source, /top: scroller\.scrollHeight,\s*behavior: 'smooth',/);
  assert.match(source, /window\.requestAnimationFrame\(scrollToBottom\)/);
  assert.match(source, /window\.setTimeout\(scrollToBottom, 50\)/);
});

test('conversation end lookup requests the latest turn position for the current session', async () => {
  const source = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');

  assert.match(source, /locateSessionEnd\(session: ProjectSessionNode\)/);
  assert.match(source, /\/latest-turn-position\?\$\{params\.toString\(\)\}/);
  assert.match(source, /return \{ contextId: response\.turnId, offset: response\.offset \}/);
});

test('scroll-to-bottom icon uses the approved arrow-to-baseline shape', async () => {
  const source = await readFile(new URL('../src/components/icons.tsx', import.meta.url), 'utf8');

  assert.match(source, /export function ScrollToBottomIcon\(\)/);
  assert.match(source, /<path d="M12 4v11" \/>/);
  assert.match(source, /<path d="m7\.5 11 4\.5 4\.5 4\.5-4\.5" \/>/);
  assert.match(source, /<path d="M5 20h14" \/>/);
});
