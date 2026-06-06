#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  loadMuninnConfig,
  resolveDatabaseHome,
  resolveDatabaseName,
  resolveStorageTarget,
} from '../packages/core/dist/config.js';
import { createNativeTables } from '../packages/core/dist/native.js';

const databaseName = resolveDatabaseName(process.env.MUNINN_DATABASE ?? null);
const databaseHome = resolveDatabaseHome(databaseName);
const targetDirs = [
  'session_snapshot',
  'extraction',
  'global_observation',
  'global_observation_context',
  'checkpoints',
];

function log(message) {
  console.log(`[clear-generated-memory] ${message}`);
}

async function countRows(label, fn) {
  try {
    const value = await fn();
    log(`${label}: ${value}`);
  } catch (error) {
    log(`${label}: unavailable (${error?.message ?? String(error)})`);
  }
}

async function main() {
  log(`database=${databaseName}`);
  log(`databaseHome=${databaseHome}`);

  const config = loadMuninnConfig() ?? {};
  const storageTarget = resolveStorageTarget(config, databaseName);
  const tables = await createNativeTables(storageTarget);
  try {
    await countRows('turn rows (kept)', async () => (await tables.turnTable.stats())?.rowCount ?? 0);
    await countRows('session_snapshot rows (clear)', async () => (
      await tables.sessionTable.listSnapshots({ mode: { type: 'recency', limit: 1_000_000 } })
    ).length);
    await countRows('extraction rows (clear)', async () => (
      await tables.extractionTable.list({ mode: { type: 'recency', limit: 1_000_000 } })
    ).length);
    await countRows('global_observation rows (clear)', async () => (await tables.globalObservationTable.stats())?.rowCount ?? 0);
    await countRows('global_observation_context rows (clear)', async () => (
      await tables.globalObservationContextTable.list({})
    ).length);
  } finally {
    await tables.close();
  }

  for (const dirName of targetDirs) {
    const target = path.join(databaseHome, dirName);
    if (!target.startsWith(`${databaseHome}${path.sep}`)) {
      throw new Error(`refusing to remove path outside database home: ${target}`);
    }
    await fs.rm(target, { recursive: true, force: true });
    log(`removed ${target}`);
  }

  log('done');
}

main().catch((error) => {
  console.error(`[clear-generated-memory] failed: ${error?.stack ?? error}`);
  process.exitCode = 1;
});
