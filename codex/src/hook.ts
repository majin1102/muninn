import type { Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CODEX_IMPORT_AGENT, defaultArtifactStore, readCodexSession, toTurnContent, type ArtifactMode, type CodexSession, type ToTurnContentOptions } from './mapping.js';
import { createMuninnClient, type MuninnClient } from './client.js';
import { resolveHookConfig } from './config.js';

const HOOK_INGEST = 'codex-hook';
const TRANSCRIPT_CACHE_VERSION = 1;
const TRANSCRIPT_CACHE_TAIL_BYTES = 4096;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 50;

type ReadSession = (sourcePath: string, options: { artifactStore: string; artifactMode: ArtifactMode }) => Promise<CodexSession | null>;

type TranscriptCacheEntry = {
  agent: string;
  project: string;
  cwd: string;
  sessionId: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  tailHash: string;
  lastByteOffset: number;
  nextTurnSequence: number;
  updatedAt: string;
};

type TranscriptCacheFile = {
  version: 1;
  transcripts: Record<string, TranscriptCacheEntry>;
};

type TranscriptFileInfo = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
};

type LatestTurnResult = {
  turn: ReturnType<typeof toTurnContent>;
  transcriptPath: string;
  cacheEntry: TranscriptCacheEntry;
};

/**
 * Generic Stop-hook capture: parse the just-completed transcript and POST its
 * latest turn to the sidecar. Shared by the Codex and Claude Code hook CLIs.
 */
export async function captureFromTranscript(params: {
  transcriptPath: string;
  readSession: ReadSession;
  toTurnOptions: ToTurnContentOptions;
  label: string;
  client?: MuninnClient;
}): Promise<boolean> {
  try {
    const transcriptPath = await realpathOrResolved(params.transcriptPath);
    return await withFileLock(`transcript-${hashLockName(transcriptPath)}`, async () => {
      const result = await readLatestTurnWithCache({
        transcriptPath,
        readSession: params.readSession,
        toTurnOptions: params.toTurnOptions,
        agent: params.toTurnOptions.agent ?? CODEX_IMPORT_AGENT,
      });
      if (!result) {
        return false;
      }
      const client = params.client ?? createMuninnClient({ config: resolveHookConfig() });
      const captured = await client.captureTurn({ turn: result.turn });
      if (captured) {
        await writeTranscriptCacheEntry(result.transcriptPath, result.cacheEntry).catch(() => undefined);
      }
      return captured;
    });
  } catch (error) {
    process.stderr.write(`[${params.label}] failed to read transcript ${params.transcriptPath}: ${String(error)}\n`);
    return false;
  }
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

async function readLatestTurnWithCache(params: {
  transcriptPath: string;
  readSession: ReadSession;
  toTurnOptions: ToTurnContentOptions;
  agent: string;
}): Promise<LatestTurnResult | null> {
  const transcriptPath = await realpathOrResolved(params.transcriptPath);
  const fileInfo = await transcriptFileInfo(transcriptPath);
  const cache = await readTranscriptCache();
  const cached = validTranscriptCacheEntry(cache.transcripts[transcriptPath], params.agent);

  if (cached) {
    if (sameTranscriptFile(fileInfo, cached) && fileInfo.size === cached.lastByteOffset && fileInfo.mtimeMs === cached.mtimeMs) {
      return null;
    }
    if (sameTranscriptFile(fileInfo, cached) && fileInfo.size > cached.lastByteOffset && await transcriptTailMatches(transcriptPath, cached)) {
      const incremental = await readIncrementalLatestTurn({
        transcriptPath,
        fileInfo,
        cached,
        readSession: params.readSession,
        toTurnOptions: params.toTurnOptions,
        agent: params.agent,
      });
      if (incremental) {
        return incremental;
      }
      return null;
    }
  }

  return readFullLatestTurn({
    transcriptPath,
    fileInfo,
    readSession: params.readSession,
    toTurnOptions: params.toTurnOptions,
    agent: params.agent,
  });
}

async function readFullLatestTurn(params: {
  transcriptPath: string;
  fileInfo: TranscriptFileInfo;
  readSession: ReadSession;
  toTurnOptions: ToTurnContentOptions;
  agent: string;
}): Promise<LatestTurnResult | null> {
  const session = await params.readSession(params.transcriptPath, { artifactStore: defaultArtifactStore(), artifactMode: 'copy' });
  if (!session || session.turns.length === 0) {
    return null;
  }
  const lastIndex = session.turns.length - 1;
  return {
    turn: toTurnContent(session, session.turns[lastIndex], lastIndex, params.toTurnOptions),
    transcriptPath: params.transcriptPath,
    cacheEntry: await cacheEntryFromSession(params.agent, session, params.transcriptPath, params.fileInfo, session.turns.length),
  };
}

async function readIncrementalLatestTurn(params: {
  transcriptPath: string;
  fileInfo: TranscriptFileInfo;
  cached: TranscriptCacheEntry;
  readSession: ReadSession;
  toTurnOptions: ToTurnContentOptions;
  agent: string;
}): Promise<LatestTurnResult | null> {
  const appended = await readFileRange(
    params.transcriptPath,
    params.cached.lastByteOffset,
    params.fileInfo.size - params.cached.lastByteOffset,
  );
  if (!appended.trim()) {
    return null;
  }

  const session = await readSessionFragment({
    content: appended,
    transcriptPath: params.transcriptPath,
    cached: params.cached,
    readSession: params.readSession,
    agent: params.agent,
  });
  if (!session || session.turns.length === 0) {
    return null;
  }

  const lastIndex = session.turns.length - 1;
  const sourceTurnSequence = params.cached.nextTurnSequence + lastIndex;
  return {
    turn: toTurnContent(session, session.turns[lastIndex], sourceTurnSequence, params.toTurnOptions),
    transcriptPath: params.transcriptPath,
    cacheEntry: await cacheEntryFromSession(
      params.agent,
      session,
      params.transcriptPath,
      params.fileInfo,
      params.cached.nextTurnSequence + session.turns.length,
    ),
  };
}

async function readSessionFragment(params: {
  content: string;
  transcriptPath: string;
  cached: TranscriptCacheEntry;
  readSession: ReadSession;
  agent: string;
}): Promise<CodexSession | null> {
  const tempPath = path.join(
    path.dirname(params.transcriptPath),
    `muninn-transcript-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`,
  );
  const prefix = params.agent === CODEX_IMPORT_AGENT
    ? `${JSON.stringify({
      type: 'session_meta',
      payload: {
        id: params.cached.sessionId,
        cwd: params.cached.cwd,
        timestamp: params.cached.updatedAt,
      },
    })}\n`
    : '';

  try {
    await writeFile(tempPath, `${prefix}${params.content}`);
    const session = await params.readSession(tempPath, { artifactStore: defaultArtifactStore(), artifactMode: 'copy' });
    if (!session) {
      return null;
    }
    session.sourcePath = params.transcriptPath;
    return session;
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

async function cacheEntryFromSession(
  agent: string,
  session: CodexSession,
  transcriptPath: string,
  fileInfo: TranscriptFileInfo,
  nextTurnSequence: number,
): Promise<TranscriptCacheEntry> {
  return {
    agent,
    project: session.project,
    cwd: session.cwd,
    sessionId: session.sessionId,
    dev: fileInfo.dev,
    ino: fileInfo.ino,
    size: fileInfo.size,
    mtimeMs: fileInfo.mtimeMs,
    tailHash: await transcriptTailHash(transcriptPath, fileInfo.size),
    lastByteOffset: fileInfo.size,
    nextTurnSequence,
    updatedAt: session.updatedAt,
  };
}

async function readFileRange(sourcePath: string, start: number, length: number): Promise<string> {
  const handle = await open(sourcePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function transcriptFileInfo(sourcePath: string): Promise<TranscriptFileInfo> {
  const fileInfo = await stat(sourcePath);
  return {
    dev: fileInfo.dev,
    ino: fileInfo.ino,
    size: fileInfo.size,
    mtimeMs: fileInfo.mtimeMs,
  };
}

function transcriptCachePath(): string {
  const home = process.env.MUNINN_HOME ?? path.join(os.homedir(), '.muninn');
  return path.join(home, 'transcript-cache.json');
}

async function readTranscriptCache(): Promise<TranscriptCacheFile> {
  try {
    const parsed = JSON.parse(await readFile(transcriptCachePath(), 'utf8')) as Partial<TranscriptCacheFile>;
    if (
      parsed
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && parsed.version === TRANSCRIPT_CACHE_VERSION
      && parsed.transcripts
      && typeof parsed.transcripts === 'object'
    ) {
      return { version: TRANSCRIPT_CACHE_VERSION, transcripts: parsed.transcripts as Record<string, TranscriptCacheEntry> };
    }
  } catch {
    // Create a new cache below.
  }
  return { version: TRANSCRIPT_CACHE_VERSION, transcripts: {} };
}

async function writeTranscriptCacheEntry(transcriptPath: string, entry: TranscriptCacheEntry): Promise<void> {
  await withFileLock('transcript-cache', async () => {
    const cache = await readTranscriptCache();
    cache.transcripts[transcriptPath] = entry;
    await atomicWriteFile(transcriptCachePath(), `${JSON.stringify(cache, null, 2)}\n`);
  });
}

function validTranscriptCacheEntry(value: unknown, agent: string): TranscriptCacheEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const entry = value as Partial<TranscriptCacheEntry>;
  if (
    entry.agent !== agent
    || typeof entry.project !== 'string'
    || typeof entry.cwd !== 'string'
    || typeof entry.sessionId !== 'string'
    || typeof entry.updatedAt !== 'string'
    || !isNonNegativeInteger(entry.dev)
    || !isNonNegativeInteger(entry.ino)
    || !isNonNegativeInteger(entry.size)
    || typeof entry.mtimeMs !== 'number'
    || !Number.isFinite(entry.mtimeMs)
    || typeof entry.tailHash !== 'string'
    || !isNonNegativeInteger(entry.lastByteOffset)
    || !isNonNegativeInteger(entry.nextTurnSequence)
  ) {
    return null;
  }
  return entry as TranscriptCacheEntry;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

async function realpathOrResolved(value: string): Promise<string> {
  const resolved = path.resolve(value);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

function sameTranscriptFile(fileInfo: TranscriptFileInfo, cached: TranscriptCacheEntry): boolean {
  return fileInfo.dev === cached.dev && fileInfo.ino === cached.ino;
}

async function transcriptTailMatches(transcriptPath: string, cached: TranscriptCacheEntry): Promise<boolean> {
  return await transcriptTailHash(transcriptPath, cached.lastByteOffset) === cached.tailHash;
}

async function transcriptTailHash(transcriptPath: string, offset: number): Promise<string> {
  const length = Math.min(offset, TRANSCRIPT_CACHE_TAIL_BYTES);
  if (length === 0) {
    return createHash('sha256').digest('hex');
  }
  const tail = await readFileRange(transcriptPath, offset - length, length);
  return createHash('sha256').update(tail).digest('hex');
}

async function atomicWriteFile(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmpPath = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(tmpPath, content, 'utf8');
  await rename(tmpPath, file);
}

type LockHandle = {
  handle: Awaited<ReturnType<typeof open>>;
  token: string;
};

async function withFileLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  const lockPath = path.join(process.env.MUNINN_HOME ?? path.join(os.homedir(), '.muninn'), 'locks', `${name}.lock`);
  await mkdir(path.dirname(lockPath), { recursive: true });
  const lock = await acquireLock(lockPath);
  try {
    return await task();
  } finally {
    await lock.handle.close().catch(() => undefined);
    await releaseLock(lockPath, lock.token);
  }
}

async function acquireLock(lockPath: string): Promise<LockHandle> {
  for (;;) {
    try {
      const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(`${process.pid}\n${token}\n${new Date().toISOString()}\n`);
      return { handle, token };
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined;
      if (code !== 'EEXIST') {
        throw error;
      }
      await removeStaleLock(lockPath);
      await sleep(LOCK_WAIT_MS);
    }
  }
}

async function removeStaleLock(lockPath: string): Promise<void> {
  try {
    const before = await readFile(lockPath, 'utf8');
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs > LOCK_STALE_MS && !lockOwnerAliveFromContent(before)) {
      if (await readFile(lockPath, 'utf8') !== before) {
        return;
      }
      await unlink(lockPath);
    }
  } catch {
    // Lock disappeared between open attempts.
  }
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    const current = await readFile(lockPath, 'utf8');
    if (current.split(/\n/)[1] === token) {
      await unlink(lockPath);
    }
  } catch {
    // Lock disappeared or was replaced by a later owner.
  }
}

function lockOwnerAliveFromContent(content: string): boolean {
  const pid = Number.parseInt(content.split(/\n/, 1)[0] ?? '', 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined;
    return code !== 'ESRCH';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashLockName(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
