import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';

import { resolveConfigPath } from '../dist/utils.js';

test('resolveConfigPath uses MUNINN_HOME/muninn.json when set', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'muninn-config-home-'));
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  t.after(async () => {
    process.chdir(originalCwd);
    delete process.env.MUNINN_HOME;
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(dir, { recursive: true, force: true });
  });

  const muninnHome = path.join(dir, 'custom-home');
  const configPath = path.join(muninnHome, 'muninn.json');

  await mkdir(muninnHome, { recursive: true });
  await writeFile(configPath, '{\n  \n}\n', 'utf8');

  process.env.MUNINN_HOME = muninnHome;
  process.env.HOME = path.join(dir, 'ignored-home');

  assert.equal(await realpath(resolveConfigPath()), await realpath(configPath));
});

test('resolveConfigPath falls back to HOME/.muninn/muninn.json when MUNINN_HOME is missing', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'muninn-config-user-'));
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  t.after(async () => {
    process.chdir(originalCwd);
    delete process.env.MUNINN_HOME;
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(dir, { recursive: true, force: true });
  });

  const cwd = path.join(dir, 'workspace', 'child');
  const userConfig = path.join(dir, 'home', '.muninn', 'muninn.json');

  await mkdir(cwd, { recursive: true });
  await mkdir(path.dirname(userConfig), { recursive: true });
  await writeFile(userConfig, '{\n  \n}\n', 'utf8');

  delete process.env.MUNINN_HOME;
  process.env.HOME = path.join(dir, 'home');
  process.chdir(cwd);

  assert.equal(await realpath(resolveConfigPath()), await realpath(userConfig));
});
