import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Turn } from '@munnai/types';

export interface StoredTurn extends Turn {
  turnId: string;
  createdAt: string;
}

function getDataDir(): string {
  return path.join(process.cwd(), '.munnai', 'data');
}

function getTurnsFilePath(): string {
  return path.join(getDataDir(), 'turns.jsonl');
}

export async function appendTurn(turn: StoredTurn): Promise<void> {
  await mkdir(getDataDir(), { recursive: true });
  await appendFile(getTurnsFilePath(), `${JSON.stringify(turn)}\n`, 'utf8');
}

async function readJsonlFile(filePath: string): Promise<StoredTurn[]> {
  const raw = await readFile(filePath, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StoredTurn);
}

export async function readTurns(): Promise<StoredTurn[]> {
  try {
    return await readJsonlFile(getTurnsFilePath());
  } catch (error: any) {
    if (error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}
