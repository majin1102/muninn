import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';

import { resolveConfigPath } from '../dist/utils.js';

test('resolveConfigPath uses MUNNAI_HOME/settings.json when set', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'munnai-config-home-'));
  const originalHome = process.env.HOME;
  t.after(async () => {
    process.chdir('/Users/Nathan/workspace/munnai');
    delete process.env.MUNNAI_HOME;
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(dir, { recursive: true, force: true });
  });

  const munnaiHome = path.join(dir, 'custom-home');
  const configPath = path.join(munnaiHome, 'settings.json');

  await mkdir(munnaiHome, { recursive: true });
  await writeFile(configPath, '{\n  \n}\n', 'utf8');

  process.env.MUNNAI_HOME = munnaiHome;
  process.env.HOME = path.join(dir, 'ignored-home');

  assert.equal(await realpath(resolveConfigPath()), await realpath(configPath));
});

test('resolveConfigPath falls back to HOME/.munnai/settings.json when MUNNAI_HOME is missing', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'munnai-config-user-'));
  const originalHome = process.env.HOME;
  t.after(async () => {
    process.chdir('/Users/Nathan/workspace/munnai');
    delete process.env.MUNNAI_HOME;
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(dir, { recursive: true, force: true });
  });

  const cwd = path.join(dir, 'workspace', 'child');
  const userConfig = path.join(dir, 'home', '.munnai', 'settings.json');

  await mkdir(cwd, { recursive: true });
  await mkdir(path.dirname(userConfig), { recursive: true });
  await writeFile(userConfig, '{\n  \n}\n', 'utf8');

  delete process.env.MUNNAI_HOME;
  process.env.HOME = path.join(dir, 'home');
  process.chdir(cwd);

  assert.equal(await realpath(resolveConfigPath()), await realpath(userConfig));
});
