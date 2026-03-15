import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Message } from '@munnai/types';

export interface StoredMessage extends Message {
  turnId: string;
  createdAt: string;
}

function getDataDir(): string {
  return path.join(process.cwd(), '.munnai', 'data');
}

function getMessagesFilePath(): string {
  return path.join(getDataDir(), 'messages.jsonl');
}

export async function appendMessage(message: StoredMessage): Promise<void> {
  await mkdir(getDataDir(), { recursive: true });
  await appendFile(getMessagesFilePath(), `${JSON.stringify(message)}\n`, 'utf8');
}

export async function readMessages(): Promise<StoredMessage[]> {
  try {
    const raw = await readFile(getMessagesFilePath(), 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StoredMessage);
  } catch (error: any) {
    if (error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}
