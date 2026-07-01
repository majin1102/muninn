#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  loadMuninnConfig,
  resolveDatabaseName,
  resolveStorageTarget,
} from '../server/dist/config.js';
import {
  resolveCheckpointPath,
  serializeCheckpointFile,
} from '../server/dist/checkpoint.js';
import { createNativeTables } from '../server/dist/native.js';

function usage() {
  return [
    'Usage:',
    '  node scripts/migrate-dreaming-project-to-checkpoint.mjs [options]',
    '',
    'Options:',
    '  --database <name>  Muninn database. Default: main or MUNINN_DATABASE',
    '  --dry-run          Print the planned checkpoint change without writing',
    '  --help             Show this help text',
  ].join('\n');
}

export function parseArgs(argv) {
  const options = {
    database: process.env.MUNINN_DATABASE ?? null,
    dryRun: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--database') {
      options.database = readValue(argv, ++index, arg);
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

export function migrateCheckpointContent(content, dreamingProjects, now = new Date(), pid = process.pid) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new Error('checkpoint must be a JSON object');
  }
  if (content.schemaVersion !== 12 && content.schemaVersion !== 13) {
    throw new Error(`unsupported checkpoint schemaVersion: ${String(content.schemaVersion)}`);
  }
  if (!content.extractor || typeof content.extractor !== 'object') {
    throw new Error('checkpoint extractor section is required');
  }
  if (!content.sessionIndex || typeof content.sessionIndex !== 'object') {
    throw new Error('checkpoint sessionIndex section is required');
  }

  const projects = {
    ...readExistingProjects(content.dreaming),
  };
  for (const row of dreamingProjects) {
    const parsed = parseDreamingProjectRow(row);
    projects[parsed.project] = {
      sessionSnapshotVersion: parsed.sessionSnapshotVersion,
    };
  }

  return {
    ...content,
    schemaVersion: 13,
    writtenAt: now.toISOString(),
    writerPid: pid,
    dreaming: { projects },
  };
}

function readExistingProjects(dreaming) {
  if (!dreaming || typeof dreaming !== 'object' || Array.isArray(dreaming)) {
    return {};
  }
  const source = dreaming.projects;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return {};
  }
  const projects = {};
  for (const [project, value] of Object.entries(source)) {
    if (
      value
      && typeof value === 'object'
      && Number.isSafeInteger(value.sessionSnapshotVersion)
      && value.sessionSnapshotVersion >= 0
    ) {
      projects[project] = {
        sessionSnapshotVersion: value.sessionSnapshotVersion,
      };
    }
  }
  return projects;
}

function parseDreamingProjectRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('dreaming_project row must be an object');
  }
  if (typeof row.project !== 'string' || row.project.length === 0) {
    throw new Error('dreaming_project row project must be a non-empty string');
  }
  if (!Number.isSafeInteger(row.sessionSnapshotVersion) || row.sessionSnapshotVersion < 0) {
    throw new Error(`dreaming_project row for ${row.project} has invalid sessionSnapshotVersion`);
  }
  return {
    project: row.project,
    sessionSnapshotVersion: row.sessionSnapshotVersion,
  };
}

async function readCheckpoint(pathname) {
  try {
    const raw = await fs.readFile(pathname, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(`checkpoint file does not exist: ${pathname}`);
    }
    throw error;
  }
}

async function writeCheckpoint(pathname, content) {
  const directory = path.dirname(pathname);
  const tmpPath = `${pathname}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(tmpPath, serializeCheckpointFile(content), 'utf8');
  await fs.rename(tmpPath, pathname);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const databaseName = resolveDatabaseName(options.database);
  const config = loadMuninnConfig() ?? {};
  const storageTarget = resolveStorageTarget(config, databaseName);
  const checkpointPath = resolveCheckpointPath(databaseName);

  const tables = await createNativeTables(storageTarget);
  try {
    const rows = await tables.dreamingProjectTable.list();
    const current = await readCheckpoint(checkpointPath);
    const next = migrateCheckpointContent(current, rows);
    const projectCount = Object.keys(next.dreaming.projects).length;

    console.log(`[migrate-dreaming-project] database=${databaseName}`);
    console.log(`[migrate-dreaming-project] checkpoint=${checkpointPath}`);
    console.log(`[migrate-dreaming-project] dreaming_project rows=${rows.length}`);
    console.log(`[migrate-dreaming-project] checkpoint projects=${projectCount}`);

    if (options.dryRun) {
      console.log(JSON.stringify({ dreaming: next.dreaming }, null, 2));
      return;
    }
    await writeCheckpoint(checkpointPath, next);
    console.log('[migrate-dreaming-project] done');
  } finally {
    await tables.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[migrate-dreaming-project] failed: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
