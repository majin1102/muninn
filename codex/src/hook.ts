import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  captureFromTranscript,
  isStopEvent,
  readStdin,
  type HookPayload,
  type MuninnClient,
} from '@muninn/common/agent-hook';
import { CODEX_IMPORT_AGENT, readCodexSession, toTurnContent } from './mapping.js';

const HOOK_INGEST = 'codex-hook';

export {
  captureFromTranscript,
  isStopEvent,
  readStdin,
};
export type {
  HookPayload as CodexHookPayload,
  MuninnClient,
};

export async function handleStop(
  payload: HookPayload,
  deps: { client?: MuninnClient; sessionsRoot?: string } = {},
): Promise<boolean> {
  const transcriptPath = await resolveTranscriptPath(payload, deps.sessionsRoot);
  if (!transcriptPath) {
    return false;
  }
  return captureFromTranscript({
    transcriptPath,
    readSession: readCodexSession,
    toTurnContent,
    toTurnOptions: { ingest: HOOK_INGEST, agent: CODEX_IMPORT_AGENT },
    label: 'muninn-codex-hook',
    client: deps.client,
  });
}

async function resolveTranscriptPath(payload: HookPayload, sessionsRoot?: string): Promise<string | null> {
  const direct = (payload.transcript_path ?? payload.agent_transcript_path ?? '').trim();
  if (direct) {
    return direct;
  }
  const sessionId = (payload.session_id ?? '').trim();
  if (!sessionId) {
    return null;
  }
  const root = sessionsRoot ?? path.join(os.homedir(), '.codex', 'sessions');
  return findSessionFile(root, sessionId);
}

async function findSessionFile(root: string, sessionId: string): Promise<string | null> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = await findSessionFile(entryPath, sessionId);
      if (found) {
        return found;
      }
    } else if (entry.isFile() && matchesSessionFile(entry.name, sessionId)) {
      return entryPath;
    }
  }
  return null;
}

function matchesSessionFile(fileName: string, sessionId: string): boolean {
  if (!fileName.endsWith('.jsonl')) {
    return false;
  }
  const baseName = path.basename(fileName, '.jsonl');
  return baseName === sessionId || baseName.endsWith(`-${sessionId}`);
}
