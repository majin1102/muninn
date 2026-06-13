import test from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_AGENT, CLAUDE_AGENT, agentLabel } from '../dist/agents.js';

test('agent constants and labels are stable', () => {
  assert.equal(CODEX_AGENT, 'codex');
  assert.equal(CLAUDE_AGENT, 'claude-code');
  assert.equal(agentLabel(CODEX_AGENT), 'Codex');
  assert.equal(agentLabel(CLAUDE_AGENT), 'Claude Code');
});
