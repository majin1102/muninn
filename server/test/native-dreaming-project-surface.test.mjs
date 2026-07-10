import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';

import { createNativeTables } from '../dist/native.js';

test('native tables no longer expose dreamingProjectTable', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'muninn-native-surface-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const tables = await createNativeTables({ uri: dir });
  t.after(async () => {
    await tables.close();
  });

  assert.equal('dreamingProjectTable' in tables, false);
});
