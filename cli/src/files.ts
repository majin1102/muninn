import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
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
  await rejectSymlink(plan.path);

  const current = await readTextFileIfExists(plan.path);
  if (current !== plan.before) {
    throw new Error(`Muninn config changed since this change was planned: ${plan.path}`);
  }

  const backupPath = await writeBackup(plan.path, plan.before, options.now?.() ?? new Date());
  await writeTarget(plan.path, plan.after);

  return {
    wrote: true,
    backupPath,
    summary: plan.summary,
  };
}

async function rejectSymlink(filePath: string): Promise<void> {
  try {
    const stat = await lstat(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to write config symlink: ${filePath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

async function writeBackup(filePath: string, content: string, date: Date): Promise<string> {
  for (let index = 0; ; index += 1) {
    const backupPath = backupFilePath(filePath, date, index);
    try {
      await writeFile(backupPath, content, { encoding: 'utf8', flag: 'wx' });
      return backupPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        continue;
      }
      throw error;
    }
  }
}

async function writeTarget(filePath: string, content: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const tempPath = `${filePath}.muninn-tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(tempPath, content, { encoding: 'utf8', flag: 'wx' });
      await rename(tempPath, filePath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        continue;
      }
      await removeTemp(tempPath);
      throw error;
    }
  }
  throw new Error(`Unable to create unique temporary config file: ${filePath}`);
}

async function removeTemp(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

function backupFilePath(filePath: string, date: Date, index: number): string {
  const stamp = date.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, '')
    .replace('T', '-');
  const backupPath = `${filePath}.muninn-backup-${stamp}`;
  return index === 0 ? backupPath : `${backupPath}-${index}`;
}
