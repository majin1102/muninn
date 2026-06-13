import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('session tree defaults time range to all sessions', async () => {
  const source = await readFile(new URL('../../web/src/components/SessionTree.tsx', import.meta.url), 'utf8');

  assert.match(source, /timePreset: 'all'/);
  assert.match(source, /session-toolbar-filter:v3/);
  assert.match(source, /setSearchParam\(url, 'time', state\.timePreset === 'all' \? null : state\.timePreset\)/);
  assert.doesNotMatch(source, /timePreset: 'last_7d'/);
  assert.doesNotMatch(source, /state\.timePreset === 'last_7d' \? null : state\.timePreset/);
});

test('session tree displays and filters sessions by latestUpdatedAt', async () => {
  const source = await readFile(new URL('../../web/src/components/SessionTree.tsx', import.meta.url), 'utf8');

  assert.match(source, /title=\{formatTimestamp\(session\.latestUpdatedAt\)\}/);
  assert.match(source, /\{formatRelativeTime\(session\.latestUpdatedAt\)\}/);
  assert.match(source, /isInRange\(session\.latestUpdatedAt, filter\.timeRange\)/);
});

test('session tree filters child items by activity time', async () => {
  const source = await readFile(new URL('../../web/src/components/SessionTree.tsx', import.meta.url), 'utf8');

  assert.match(source, /function itemActivityAt\(item: ProjectSegmentNode \| ProjectTurnNode\): string/);
  assert.match(source, /return item\.updatedAt \?\? item\.createdAt;/);
  assert.match(source, /\.filter\(\(item\) => isInRange\(itemActivityAt\(item\), filter\.timeRange\)\)/);
  assert.match(source, /\.sort\(\(left, right\) => compare\(itemActivityAt\(left\), itemActivityAt\(right\)\)\)/);
  assert.doesNotMatch(source, /\.filter\(\(item\) => isInRange\(item\.createdAt, filter\.timeRange\)\)/);
});

test('session tree empty import guide is actionable', async () => {
  const source = await readFile(new URL('../../web/src/components/SessionTree.tsx', import.meta.url), 'utf8');

  assert.match(source, /onImportSessions\?: \(\) => void/);
  assert.match(source, /className="empty-action-row session-import-empty-action"/);
  assert.match(source, /onClick=\{onImportSessions\}/);
  assert.match(source, /<Plus aria-hidden="true" \/>/);
  assert.doesNotMatch(source, /Import as ImportIcon/);
  assert.doesNotMatch(source, /<button type="button" disabled>/);
});

test('session tree uses project agent session identity instead of cwd for row keys', async () => {
  const treeSource = await readFile(new URL('../../web/src/components/SessionTree.tsx', import.meta.url), 'utf8');
  const stateSource = await readFile(new URL('../../web/src/lib/session_content_state.ts', import.meta.url), 'utf8');
  const apiSource = await readFile(new URL('../../web/src/lib/api.ts', import.meta.url), 'utf8');
  const serverSource = await readFile(new URL('../src/ui/app.ts', import.meta.url), 'utf8');

  assert.match(treeSource, /SessionIdentity\.sessionIdentityKey\(\{\s*project: session\.projectKey,\s*agent: session\.agent,\s*sessionId: session\.sessionKey,/);
  assert.doesNotMatch(treeSource, /session\.agent\}:\$\{session\.cwd \?\? ''\}:\$\{session\.sessionKey\}/);
  assert.match(stateSource, /projectKey: string;/);
  assert.match(stateSource, /SessionIdentity\.sessionIdentityKey\(\{\s*project: session\.projectKey,\s*agent: session\.agent,\s*sessionId: session\.sessionKey,/);
  assert.match(apiSource, /params\.set\('project', session\.projectKey\)/);
  assert.doesNotMatch(apiSource, /params\.set\('cwd', session\.cwd\)/);
  assert.match(serverSource, /const project = normalizeText\(c\.req\.query\('project'\)\)/);
  assert.doesNotMatch(serverSource, /cwd is required/);
});
