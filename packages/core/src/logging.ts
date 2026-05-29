import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { resolveDatabaseLogPath, resolveDatabaseName } from './config.js';

export type MuninnLogLevel = 'info' | 'warn' | 'error';

export type MuninnLogRecord = {
  ts: string;
  level: MuninnLogLevel;
  database: string;
  component: string;
  event: string;
  details: Record<string, unknown>;
};

export async function writeMuninnLog(
  database: string | null | undefined,
  level: MuninnLogLevel,
  component: string,
  event: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  const databaseName = resolveDatabaseName(database);
  const file = resolveDatabaseLogPath(databaseName, 'muninn.jsonl');
  const record: MuninnLogRecord = {
    ts: new Date().toISOString(),
    level,
    database: databaseName,
    component,
    event,
    details,
  };
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[muninn:logger] failed to write muninn.jsonl: ${message}`);
  }
}
