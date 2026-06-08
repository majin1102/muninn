import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('session tree defaults time range to all sessions', async () => {
  const source = await readFile(new URL('../src/components/SessionTree.tsx', import.meta.url), 'utf8');

  assert.match(source, /timePreset: 'all'/);
  assert.match(source, /session-toolbar-filter:v3/);
  assert.match(source, /setSearchParam\(url, 'time', state\.timePreset === 'all' \? null : state\.timePreset\)/);
  assert.doesNotMatch(source, /timePreset: 'last_7d'/);
  assert.doesNotMatch(source, /state\.timePreset === 'last_7d' \? null : state\.timePreset/);
});

test('session tree displays and filters sessions by latestUpdatedAt', async () => {
  const source = await readFile(new URL('../src/components/SessionTree.tsx', import.meta.url), 'utf8');

  assert.match(source, /title=\{formatTimestamp\(session\.latestUpdatedAt\)\}/);
  assert.match(source, /\{formatRelativeTime\(session\.latestUpdatedAt\)\}/);
  assert.match(source, /isInRange\(session\.latestUpdatedAt, filter\.timeRange\)/);
});

test('session tree filters child items by activity time', async () => {
  const source = await readFile(new URL('../src/components/SessionTree.tsx', import.meta.url), 'utf8');

  assert.match(source, /function itemActivityAt\(item: ProjectSegmentNode \| ProjectTurnNode\): string/);
  assert.match(source, /return item\.updatedAt \?\? item\.createdAt;/);
  assert.match(source, /\.filter\(\(item\) => isInRange\(itemActivityAt\(item\), filter\.timeRange\)\)/);
  assert.match(source, /\.sort\(\(left, right\) => compare\(itemActivityAt\(left\), itemActivityAt\(right\)\)\)/);
  assert.doesNotMatch(source, /\.filter\(\(item\) => isInRange\(item\.createdAt, filter\.timeRange\)\)/);
});
