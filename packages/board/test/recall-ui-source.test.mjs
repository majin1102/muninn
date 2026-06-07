import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('recall UI runs search before optional streaming agent recall', async () => {
  const source = await readFile(new URL('../src/components/SearchPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /client\.searchRecall/);
  assert.match(source, /provider === 'none'/);
  assert.match(source, /client\.streamAgentRecall/);
  assert.match(source, /setAnswerText\(\(current\) => `\$\{current\}\$\{agentEvent\.text\}`\)/);
  assert.doesNotMatch(source, /BotMessageSquare/);
});
