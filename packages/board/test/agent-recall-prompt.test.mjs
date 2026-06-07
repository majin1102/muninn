import assert from 'node:assert/strict';
import test from 'node:test';

async function loadAgentRecallServer() {
  return import(new URL('../dist-server/agent_recall.js', import.meta.url));
}

test('agent recall prompt handles synthesis, uncertainty, contradictions, and timestamps', async () => {
  const { __testing } = await loadAgentRecallServer();

  assert.match(__testing.systemPrompt, /recall synthesis agent/i);
  assert.match(__testing.systemPrompt, /Prefer newer context/i);
  assert.match(__testing.systemPrompt, /contradictory information/i);
  assert.match(__testing.systemPrompt, /related background but not the specific answer/i);
  assert.match(__testing.systemPrompt, /Do not invent facts/i);

  const prompt = __testing.agentPrompt('What changed about provider routing?', [
    {
      sessionKey: 'board-mvp',
      sessionLabel: 'Board MVP',
      projectKey: 'muninn',
      latestUpdatedAt: '2026-06-02T10:36:00.000Z',
      items: [
        {
          id: 'hit-1',
          source: 'conversation',
          title: 'Provider selector and model routing',
          content: 'Provider selection should start as a visual control.',
          createdAt: '2026-06-02T10:30:00.000Z',
          memoryId: 'turn:1020',
          links: [],
        },
      ],
    },
  ]);

  assert.match(prompt, /<result id="1\.1">/);
  assert.match(prompt, /Session: Board MVP/);
  assert.match(prompt, /Source: conversation/);
  assert.match(prompt, /Created at: 2026-06-02T10:30:00.000Z/);
  assert.match(prompt, /<\/result>/);
  assert.match(prompt, /Final answer:/);
});
