#!/usr/bin/env node
import {
  getExtractorLlmConfig,
  loadMuninnConfig,
  resolveDatabaseName,
  resolveStorageTarget,
} from '../packages/core/dist/config.js';
import { createNativeTables } from '../packages/core/dist/native.js';
import { __testing as updateTesting } from '../packages/core/dist/extractor/update.js';

function usage() {
  return [
    'Usage:',
    '  node scripts/run-session-extractor.mjs --session-id <id> [--database main] [--agent codex]',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    database: 'main',
    sessionId: '',
    agent: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--database') {
      options.database = readValue(argv, ++index, arg);
      continue;
    }
    if (arg === '--session-id') {
      options.sessionId = readValue(argv, ++index, arg);
      continue;
    }
    if (arg === '--agent') {
      options.agent = readValue(argv, ++index, arg);
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

function readValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function log(message) {
  console.log(`[run-session-extractor] ${message}`);
}

function compareTurns(left, right) {
  return left.createdAt.localeCompare(right.createdAt)
    || left.updatedAt.localeCompare(right.updatedAt)
    || left.turnId.localeCompare(right.turnId);
}

function turnSessionId(turn) {
  return turn.sessionId ?? turn.session_id ?? null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.sessionId) {
    throw new Error('--session-id is required');
  }

  const databaseName = resolveDatabaseName(options.database);
  const config = loadMuninnConfig() ?? {};
  const extractorConfig = getExtractorLlmConfig();
  if (!extractorConfig) {
    throw new Error('extractor config is missing');
  }

  log(`database=${databaseName}`);
  log(`sessionId=${options.sessionId}`);
  log(`agent=${options.agent || '(any)'}`);
  log(`extractor=${extractorConfig.name}`);

  const tables = await createNativeTables(resolveStorageTarget(config, databaseName));
  try {
    const turns = (await tables.turnTable.listTurns({
      mode: { type: 'page', offset: 0, limit: 1_000_000 },
      sessionId: options.sessionId,
      ...(options.agent ? { agent: options.agent } : {}),
    }))
      .filter((turn) => turnSessionId(turn) === options.sessionId)
      .filter((turn) => !options.agent || turn.agent === options.agent)
      .map((turn) => ({
        ...turn,
        sessionId: turnSessionId(turn),
      }))
      .sort(compareTurns);

    log(`matchedTurns=${turns.length}`);
    if (turns.length === 0) {
      return;
    }

    const latestEpoch = Math.max(1, ...turns.map((turn) => turn.observingEpoch ?? 0));
    const result = await updateTesting.extractEpoch({
      client: tables,
      extractorName: extractorConfig.name,
      activeWindowDays: extractorConfig.activeWindowDays,
      threads: [],
      sealedEpoch: {
        epoch: latestEpoch,
        turns,
      },
      database: databaseName,
    });
    log(`touchedThreads=${result.touchedIds.size}`);

    const extractionChanges = await updateTesting.buildTouchedIndex(tables, result.threads, result.touchedIds);
    log(`extractionChanges=${extractionChanges.length}`);

    const sessionSnapshots = await tables.sessionTable.threadSnapshots(options.sessionId);
    const extractionRows = await tables.extractionTable.list({ limit: 1_000_000 });
    log(`sessionSnapshotsForSession=${sessionSnapshots.length}`);
    log(`totalExtractionRows=${extractionRows.length}`);
    log('done');
  } finally {
    await tables.close();
  }
}

main().catch((error) => {
  console.error(`[run-session-extractor] failed: ${error?.stack ?? error}`);
  process.exitCode = 1;
});
