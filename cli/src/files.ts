import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChangePlan } from './model.js';

export type ApplyResult = {
  wrote: boolean;
  backupPath: string | null;
  summary: string[];
};

export async function readTextFileIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

export async function applyChangePlan(plan: ChangePlan, options: {
  dryRun: boolean;
  now?: () => Date;
}): Promise<ApplyResult> {
  if (!plan.changed) {
    return {
      wrote: false,
      backupPath: null,
      summary: plan.summary,
    };
  }

  if (options.dryRun) {
    return {
      wrote: false,
      backupPath: null,
      summary: plan.summary,
    };
  }

  await mkdir(path.dirname(plan.path), { recursive: true });
  const backupPath = backupFilePath(plan.path, options.now?.() ?? new Date());
  if (plan.before) {
    await writeFile(backupPath, plan.before, 'utf8');
  }

  const tempPath = `${plan.path}.muninn-tmp-${process.pid}`;
  await writeFile(tempPath, plan.after, 'utf8');
  await rename(tempPath, plan.path);

  return {
    wrote: true,
    backupPath: plan.before ? backupPath : null,
    summary: plan.summary,
  };
}

function backupFilePath(filePath: string, date: Date): string {
  const stamp = date.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, '')
    .replace('T', '-');
  return `${filePath}.muninn-backup-${stamp}`;
}
