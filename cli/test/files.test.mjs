import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
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

test('applyChangePlan writes backup for empty previous content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-files-'));
  const file = path.join(root, 'config.toml');
  await writeFile(file, '');

  const result = await applyChangePlan({
    changed: true,
    path: file,
    before: '',
    after: 'new\n',
    summary: ['change file'],
  }, {
    dryRun: false,
    now: () => new Date('2026-06-14T03:00:00.000Z'),
  });

  assert.equal(result.wrote, true);
  assert.match(result.backupPath, /config\.toml\.muninn-backup-20260614-030000$/);
  assert.equal(await readFile(result.backupPath, 'utf8'), '');
  assert.equal(await readFile(file, 'utf8'), 'new\n');
});

test('applyChangePlan rejects when config changed after planning', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-files-'));
  const file = path.join(root, 'config.toml');
  await writeFile(file, 'before\n');
  await writeFile(file, 'outside change\n');

  await assert.rejects(
    () => applyChangePlan({
      changed: true,
      path: file,
      before: 'before\n',
      after: 'after\n',
      summary: ['change file'],
    }, {
      dryRun: false,
      now: () => new Date('2026-06-14T03:00:00.000Z'),
    }),
    /config changed/i,
  );

  assert.equal(await readFile(file, 'utf8'), 'outside change\n');
  assert.deepEqual(await readdir(root), ['config.toml']);
});

test('applyChangePlan creates unique backup paths for repeated timestamp', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-files-'));
  const file = path.join(root, 'config.toml');
  const now = () => new Date('2026-06-14T03:00:00.000Z');
  await writeFile(file, 'before\n');

  const first = await applyChangePlan({
    changed: true,
    path: file,
    before: 'before\n',
    after: 'after first\n',
    summary: ['change file'],
  }, {
    dryRun: false,
    now,
  });

  const second = await applyChangePlan({
    changed: true,
    path: file,
    before: 'after first\n',
    after: 'after second\n',
    summary: ['change file again'],
  }, {
    dryRun: false,
    now,
  });

  assert.match(first.backupPath, /config\.toml\.muninn-backup-20260614-030000$/);
  assert.match(second.backupPath, /config\.toml\.muninn-backup-20260614-030000-1$/);
  assert.equal(await readFile(first.backupPath, 'utf8'), 'before\n');
  assert.equal(await readFile(second.backupPath, 'utf8'), 'after first\n');
  assert.equal(await readFile(file, 'utf8'), 'after second\n');
});

test('applyChangePlan rejects symlink targets without replacing symlink', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-files-'));
  const target = path.join(root, 'real-config.toml');
  const link = path.join(root, 'config.toml');
  await writeFile(target, 'before\n');
  await symlink(target, link);

  await assert.rejects(
    () => applyChangePlan({
      changed: true,
      path: link,
      before: 'before\n',
      after: 'after\n',
      summary: ['change file'],
    }, {
      dryRun: false,
      now: () => new Date('2026-06-14T03:00:00.000Z'),
    }),
    /symlink/i,
  );

  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.equal(await readFile(target, 'utf8'), 'before\n');
});
