import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { applyChangePlan, readTextFileIfExists } from '../dist/files.js';

test('readTextFileIfExists returns empty string for missing files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-files-'));
  assert.equal(await readTextFileIfExists(path.join(root, 'missing.txt')), '');
});

test('applyChangePlan dry-run does not write files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-files-'));
  const file = path.join(root, 'config.toml');
  await writeFile(file, 'before\n');

  const result = await applyChangePlan({
    changed: true,
    path: file,
    before: 'before\n',
    after: 'after\n',
    summary: ['change file'],
  }, {
    dryRun: true,
    now: () => new Date('2026-06-14T03:00:00.000Z'),
  });

  assert.equal(result.wrote, false);
  assert.equal(result.backupPath, null);
  assert.equal(await readFile(file, 'utf8'), 'before\n');
});

test('applyChangePlan writes backup before replacing content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-files-'));
  const file = path.join(root, 'config.toml');
  await writeFile(file, 'before\n');

  const result = await applyChangePlan({
    changed: true,
    path: file,
    before: 'before\n',
    after: 'after\n',
    summary: ['change file'],
  }, {
    dryRun: false,
    now: () => new Date('2026-06-14T03:00:00.000Z'),
  });

  assert.equal(result.wrote, true);
  assert.match(result.backupPath, /config\.toml\.muninn-backup-20260614-030000$/);
  assert.equal(await readFile(result.backupPath, 'utf8'), 'before\n');
  assert.equal(await readFile(file, 'utf8'), 'after\n');
});
