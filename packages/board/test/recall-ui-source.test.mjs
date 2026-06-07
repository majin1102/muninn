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

test('recall API stream reader gates events after abort', async () => {
  const source = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');

  assert.match(source, /readAgentRecallStream\(response, params\.onEvent, params\.signal\)/);
  assert.match(source, /signal\?\.aborted/);
});

test('recall results render source links into the session route', async () => {
  const source = await readFile(new URL('../src/components/SearchPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /item\.links/);
  assert.equal(source.includes('#/session/${encodeURIComponent(link.memoryId)}'), true);
});
