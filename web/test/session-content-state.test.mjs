import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampTimelineWidth,
  conversationLocatorTurnIds,
  gridTemplateForMode,
  hasSessionContext,
  locateConversationEnabled,
  locateTimelineEnabled,
  TIMELINE_MIN_WIDTH,
  sessionTreeCanExpand,
  selectedSessionKey,
  timelineItemForConversationWindow,
  toggleSessionTreeLayoutMode,
} from '../src/lib/session-content-state.ts';

test('clamps timeline split width to keep both panes usable', () => {
  assert.equal(clampTimelineWidth(120, 1200), TIMELINE_MIN_WIDTH);
  assert.equal(clampTimelineWidth(460, 1200), 460);
  assert.equal(clampTimelineWidth(960, 1200), 680);
  assert.equal(clampTimelineWidth(420, 313), 172);
});

test('builds stable grid templates for each content mode', () => {
  assert.equal(gridTemplateForMode('split', 420), 'minmax(0, min(420px, 55%)) 1px minmax(0, 1fr)');
  assert.equal(gridTemplateForMode('split', 420, 313), '172px 1px minmax(0, 1fr)');
  assert.equal(gridTemplateForMode('conversation', 420), '0 0 minmax(0, 1fr)');
});

test('allows session tree expansion only when timeline pane is collapsed', () => {
  assert.equal(sessionTreeCanExpand('split'), false);
  assert.equal(sessionTreeCanExpand('conversation'), true);
});

test('cycles session tree layout through split, conversation-only, and collapsed modes', () => {
  assert.equal(toggleSessionTreeLayoutMode('split'), 'conversation');
  assert.equal(toggleSessionTreeLayoutMode('conversation'), 'collapsed');
  assert.equal(toggleSessionTreeLayoutMode('collapsed'), 'split');
});

test('requires a selected session or document before rendering session content', () => {
  assert.equal(hasSessionContext(null, null), false);
  assert.equal(hasSessionContext(undefined, undefined), false);
  assert.equal(hasSessionContext({ sessionKey: 's1' }, null), true);
  assert.equal(hasSessionContext(null, { title: 'Imported session' }), true);
});

test('enables conversation locate only when the selected timeline item is outside the conversation window', () => {
  const item = { memoryId: 'timeline:1', refs: ['turn:2'] };

  assert.equal(locateConversationEnabled(null, ['turn:1']), false);
  assert.equal(locateConversationEnabled(item, ['turn:1', 'turn:2', 'turn:3']), false);
  assert.equal(locateConversationEnabled(item, ['turn:10', 'turn:11']), true);
});

test('selects the first matching timeline item in the conversation window', () => {
  const timeline = [
    { memoryId: 'timeline:1', refs: ['turn:8'] },
    { memoryId: 'timeline:2', refs: ['turn:3', 'turn:6'] },
    { memoryId: 'timeline:3', refs: ['turn:6'] },
  ];

  assert.equal(timelineItemForConversationWindow(timeline, ['turn:1', 'turn:3', 'turn:6'])?.memoryId, 'timeline:2');
  assert.equal(timelineItemForConversationWindow(timeline, ['turn:4', 'turn:5']), null);
});

test('selects the nearest started timeline item when refs overlap', () => {
  const timeline = [
    { memoryId: 'timeline:1', refs: ['turn:1', 'turn:9'] },
    { memoryId: 'timeline:2', refs: ['turn:5'] },
    { memoryId: 'timeline:3', refs: ['turn:10'] },
  ];

  assert.equal(
    timelineItemForConversationWindow(
      timeline,
      ['turn:9'],
      ['turn:1', 'turn:5', 'turn:9', 'turn:10'],
    )?.memoryId,
    'timeline:2',
  );
});

test('uses visible conversation turns before the inferred conversation window', () => {
  assert.deepEqual(
    conversationLocatorTurnIds(['turn:90', 'turn:91'], ['turn:1', 'turn:2']),
    ['turn:90', 'turn:91'],
  );
  assert.deepEqual(
    conversationLocatorTurnIds([], ['turn:1', 'turn:2']),
    ['turn:1', 'turn:2'],
  );
});

test('enables timeline locate only when the window match is not already active and open', () => {
  const item = { memoryId: 'timeline:2', refs: ['turn:3'] };

  assert.equal(locateTimelineEnabled(null, null), false);
  assert.equal(locateTimelineEnabled(item, null), true);
  assert.equal(locateTimelineEnabled(item, 'timeline:1'), true);
  assert.equal(locateTimelineEnabled(item, 'timeline:2'), false);
  assert.equal(locateTimelineEnabled(item, 'timeline:1', ['turn:9'], { memoryId: 'timeline:1', refs: ['turn:9'] }), true);
});

test('resolves selected session identity from project agent and session key', () => {
  assert.equal(selectedSessionKey({
    projectKey: '/Users/Nathan/workspace/muninn',
    agent: 'codex',
    cwd: '/Users/Nathan/workspace/muninn',
    sessionKey: 'raw-session-id',
  }), '/Users/Nathan/workspace/muninn\u001fcodex\u001fraw-session-id');
});
