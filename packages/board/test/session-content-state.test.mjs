import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampObservationWidth,
  conversationLocatorTurnIds,
  gridTemplateForMode,
  hasSessionContext,
  locateConversationEnabled,
  locateObservationEnabled,
  OBSERVATION_MIN_WIDTH,
  observationForConversationWindow,
  sessionTreeCanExpand,
  selectedSessionKey,
  toggleSessionTreeLayoutMode,
} from '../src/lib/session_content_state.ts';

test('clamps observation split width to keep both panes usable', () => {
  assert.equal(clampObservationWidth(120, 1200), OBSERVATION_MIN_WIDTH);
  assert.equal(clampObservationWidth(460, 1200), 460);
  assert.equal(clampObservationWidth(960, 1200), 680);
  assert.equal(clampObservationWidth(420, 313), 172);
});

test('builds stable grid templates for each content mode', () => {
  assert.equal(gridTemplateForMode('split', 420), 'minmax(0, min(420px, 55%)) 1px minmax(0, 1fr)');
  assert.equal(gridTemplateForMode('split', 420, 313), '172px 1px minmax(0, 1fr)');
  assert.equal(gridTemplateForMode('conversation', 420), '0 0 minmax(0, 1fr)');
});

test('allows session tree expansion only when observation pane is collapsed', () => {
  assert.equal(sessionTreeCanExpand('split'), false);
  assert.equal(sessionTreeCanExpand('conversation'), true);
});

test('toggles session tree layout between conversation-only and split modes', () => {
  assert.equal(toggleSessionTreeLayoutMode('conversation'), 'split');
  assert.equal(toggleSessionTreeLayoutMode('split'), 'conversation');
});

test('requires a selected session or document before rendering session content', () => {
  assert.equal(hasSessionContext(null, null), false);
  assert.equal(hasSessionContext(undefined, undefined), false);
  assert.equal(hasSessionContext({ sessionKey: 's1' }, null), true);
  assert.equal(hasSessionContext(null, { title: 'Imported session' }), true);
});

test('enables conversation locate only when the selected observation is outside the conversation window', () => {
  const observation = { memoryId: 'obs:1', refs: ['turn:2'] };

  assert.equal(locateConversationEnabled(null, ['turn:1']), false);
  assert.equal(locateConversationEnabled(observation, ['turn:1', 'turn:2', 'turn:3']), false);
  assert.equal(locateConversationEnabled(observation, ['turn:10', 'turn:11']), true);
});

test('selects the first matching observation in the conversation window', () => {
  const observations = [
    { memoryId: 'obs:1', refs: ['turn:8'] },
    { memoryId: 'obs:2', refs: ['turn:3', 'turn:6'] },
    { memoryId: 'obs:3', refs: ['turn:6'] },
  ];

  assert.equal(observationForConversationWindow(observations, ['turn:1', 'turn:3', 'turn:6'])?.memoryId, 'obs:2');
  assert.equal(observationForConversationWindow(observations, ['turn:4', 'turn:5']), null);
});

test('selects the nearest started observation when refs overlap', () => {
  const observations = [
    { memoryId: 'obs:1', refs: ['turn:1', 'turn:9'] },
    { memoryId: 'obs:2', refs: ['turn:5'] },
    { memoryId: 'obs:3', refs: ['turn:10'] },
  ];

  assert.equal(
    observationForConversationWindow(
      observations,
      ['turn:9'],
      ['turn:1', 'turn:5', 'turn:9', 'turn:10'],
    )?.memoryId,
    'obs:2',
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

test('enables observation locate only when the window match is not already active and open', () => {
  const observation = { memoryId: 'obs:2', refs: ['turn:3'] };

  assert.equal(locateObservationEnabled(null, null), false);
  assert.equal(locateObservationEnabled(observation, null), true);
  assert.equal(locateObservationEnabled(observation, 'obs:1'), true);
  assert.equal(locateObservationEnabled(observation, 'obs:2'), false);
  assert.equal(locateObservationEnabled(observation, 'obs:1', ['turn:9'], { memoryId: 'obs:1', refs: ['turn:9'] }), true);
});

test('resolves selected session identity from agent, project, and session key', () => {
  assert.equal(selectedSessionKey({
    agent: 'codex',
    projectKey: 'muninn',
    sessionKey: 'raw-session-id',
  }), 'codex:muninn:raw-session-id');
});
