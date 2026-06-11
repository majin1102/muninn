import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultArtifactStore, readCodexSession, toTurnContent, type ArtifactMode, type CodexSession, type ToTurnContentOptions } from './mapping.js';
import { createMuninnClient, type MuninnClient } from './client.js';
import { resolveHookConfig } from './config.js';

const HOOK_INGEST = 'codex-hook';

/**
 * Generic Stop-hook capture: parse the just-completed transcript and POST its
 * latest turn to the sidecar. Shared by the Codex and Claude Code hook CLIs.
 */
export async function captureFromTranscript(params: {
  transcriptPath: string;
  readSession: (sourcePath: string, options: { artifactStore: string; artifactMode: ArtifactMode }) => Promise<CodexSession | null>;
  toTurnOptions: ToTurnContentOptions;
  label: string;
  client?: MuninnClient;
}): Promise<boolean> {
  let session: CodexSession | null;
  try {
    session = await params.readSession(params.transcriptPath, { artifactStore: defaultArtifactStore(), artifactMode: 'copy' });
  } catch (error) {
    process.stderr.write(`[${params.label}] failed to read transcript ${params.transcriptPath}: ${String(error)}\n`);
    return false;
  }
  if (!session || session.turns.length === 0) {
    return false;
  }
  const lastIndex = session.turns.length - 1;
  const turn = toTurnContent(session, session.turns[lastIndex], lastIndex, params.toTurnOptions);
  const client = params.client ?? createMuninnClient({ config: resolveHookConfig() });
  return client.captureTurn({ turn });
}

/** Read all of stdin (the hook event JSON). Resolves '' on a TTY. */
export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    if (process.stdin.isTTY) {
      finish();
      return;
    }
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

/**
 * Subset of the Codex lifecycle-hook payload (Claude-Code-style, snake_case
 * keys) that the Stop handler relies on. All fields are optional because the
 * handler must degrade gracefully on contract drift.
 */
export type CodexHookPayload = {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  agent_transcript_path?: string;
  cwd?: string;
  turn_id?: string;
};

export function isStopEvent(payload: CodexHookPayload): boolean {
  return (payload.hook_event_name ?? '').trim().toLowerCase() === 'stop';
}

/**
 * Handle a Stop hook: re-parse the just-completed session transcript and POST
 * its latest turn to the sidecar, reusing board-import's field mapping.
 * Returns true when a turn was captured.
 */
export async function handleStop(
  payload: CodexHookPayload,
  deps: { client?: MuninnClient; sessionsRoot?: string } = {},
): Promise<boolean> {
  const transcriptPath = await resolveTranscriptPath(payload, deps.sessionsRoot);
  if (!transcriptPath) {
    return false;
  }
  return captureFromTranscript({
    transcriptPath,
    readSession: readCodexSession,
    toTurnOptions: { ingest: HOOK_INGEST },
    label: 'muninn-codex-hook',
    client: deps.client,
  });
}

async function resolveTranscriptPath(payload: CodexHookPayload, sessionsRoot?: string): Promise<string | null> {
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
    } else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(sessionId)) {
      return entryPath;
    }
  }
  return null;
}
