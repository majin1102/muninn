import { createHash } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TurnContent } from './api';
import { CODEX_AGENT } from './agents';
import type { CapturePolicyFile, CaptureProgressFile } from './capture-policy';
import { muninnSessionKey, type MuninnSessionIdentity } from './session-identity';
import { resolveMuninnServerBaseUrl } from './server-url';

export type ArtifactMode = 'preview' | 'copy';

export type AgentTurn = {
  prompt: string;
  response: string;
  promptTimestamp: string;
  responseTimestamp: string;
};

export type AgentSession<Turn extends AgentTurn = AgentTurn> = {
  sessionId: string;
  cwd: string;
  project: string;
  sourcePath: string;
  updatedAt: string;
  turns: Turn[];
};

export type ToTurnContentOptions = {
  agent?: string;
  ingest?: string;
  markerKey?: string;
};

export type ReadAgentSession<Session extends AgentSession = AgentSession> = (
  sourcePath: string,
  options: { artifactStore: string; artifactMode: ArtifactMode },
) => Promise<Session | null>;

export type ToTurnContent<Session extends AgentSession = AgentSession> = (
  session: Session,
  turn: Session['turns'][number],
  index: number,
  options: ToTurnContentOptions,
) => TurnContent;

export type HookConfig = {
  baseUrl: string;
  timeoutMs: number;
};

export type CaptureTurnRequest = {
  turn: TurnContent;
};

export type FetchResponseLike = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
};

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FetchResponseLike>;

export type MuninnClient = {
  captureTurn(request: CaptureTurnRequest): Promise<boolean>;
  deleteSession?(identity: MuninnSessionIdentity): Promise<boolean>;
};

export type HookPayload = {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  agent_transcript_path?: string;
  cwd?: string;
  turn_id?: string;
};

const DEFAULT_TIMEOUT_MS = 1500;
const TRANSCRIPT_CACHE_TAIL_BYTES = 4096;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 50;
const CAPTURE_MARKER_NONCE = 'muninn-capture-v1';

type CaptureMarkerAction = 'enable' | 'disable';

type CaptureProgressEntry = NonNullable<CaptureProgressFile['sessions']>[string] & {
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

type TranscriptFileInfo = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
};

type LatestTurnsResult = {
  turns: TurnContent[];
  transcriptPath: string;
  sessionKey: string;
  progressEntry: CaptureProgressEntry;
  markerAction: CaptureMarkerAction | null;
};

export function resolveHookConfig(env: NodeJS.ProcessEnv = process.env): HookConfig {
  return {
    baseUrl: resolveMuninnServerBaseUrl({ env }),
    timeoutMs: resolveTimeoutMs(env.MUNINN_HOOK_TIMEOUT_MS),
  };
}

export function createMuninnClient(params: { config: HookConfig; fetchImpl?: FetchLike; label?: string }): MuninnClient {
  const fetchImpl = (params.fetchImpl ?? (fetch as unknown as FetchLike));
  const label = params.label ?? 'muninn-agent-hook';
  return {
    async captureTurn(request) {
      try {
        const response = await fetchImpl(`${params.config.baseUrl}/api/v1/turn/capture`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(params.config.timeoutMs),
        });
        if (!response.ok) {
          const body = await safeReadBody(response);
          logWarn(label, `muninn capture failed with status ${response.status}${body ? ` body=${body}` : ''}`);
          return false;
        }
        return true;
      } catch (error) {
        logWarn(label, 'muninn capture request failed', error);
        return false;
      }
    },
    async deleteSession(identity) {
      try {
        const response = await fetchImpl(`${params.config.baseUrl}/app/api/import/${encodeURIComponent(identity.agent)}/session`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            project: identity.project,
            sessionId: identity.sessionId,
          }),
          signal: AbortSignal.timeout(params.config.timeoutMs),
        });
        if (!response.ok) {
          const body = await safeReadBody(response);
          logWarn(label, `muninn delete session failed with status ${response.status}${body ? ` body=${body}` : ''}`);
          return false;
        }
        return true;
      } catch (error) {
        logWarn(label, 'muninn delete session request failed', error);
        return false;
      }
    },
  };
}

export function defaultArtifactStore(): string {
  const home = process.env.MUNINN_HOME ?? path.join(os.homedir(), '.muninn');
  return path.join(home, 'default', 'artifacts');
}

export async function captureFromTranscript<Session extends AgentSession>(params: {
  transcriptPath: string;
  readSession: ReadAgentSession<Session>;
  toTurnContent: ToTurnContent<Session>;
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
        toTurnContent: params.toTurnContent,
        toTurnOptions: params.toTurnOptions,
        agent: params.toTurnOptions.agent ?? CODEX_AGENT,
      });
      if (!result) {
        return false;
      }
      if (result.markerAction) {
        return await applyCaptureMarker({
          ...params,
          transcriptPath,
          result,
          agent: params.toTurnOptions.agent ?? CODEX_AGENT,
        });
      }
      if (!await isHookCaptureEnabled(result.sessionKey, result.progressEntry)) {
        return false;
      }
      const client = params.client ?? createMuninnClient({ config: resolveHookConfig(), label: params.label });
      let captured = result.turns.length > 0;
      for (const turn of result.turns) {
        captured = await client.captureTurn({ turn }) && captured;
      }
      if (captured) {
        await writeCaptureProgressEntry(result.sessionKey, result.progressEntry).catch(() => undefined);
      }
      return captured;
    });
  } catch (error) {
    process.stderr.write(`[${params.label}] failed to read transcript ${params.transcriptPath}: ${String(error)}\n`);
    return false;
  }
}

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

export function isStopEvent(payload: HookPayload): boolean {
  return (payload.hook_event_name ?? '').trim().toLowerCase() === 'stop';
}

async function readLatestTurnWithCache<Session extends AgentSession>(params: {
  transcriptPath: string;
  readSession: ReadAgentSession<Session>;
  toTurnContent: ToTurnContent<Session>;
  toTurnOptions: ToTurnContentOptions;
  agent: string;
}): Promise<LatestTurnsResult | null> {
  const transcriptPath = await realpathOrResolved(params.transcriptPath);
  const fileInfo = await transcriptFileInfo(transcriptPath);
  const progress = await readCaptureProgress();
  const cached = Object.values(progress.sessions ?? {})
    .map((value) => validCaptureProgressEntry(value, params.agent, transcriptPath))
    .find((entry): entry is CaptureProgressEntry => entry !== null);

  if (cached) {
    if (sameTranscriptFile(fileInfo, cached) && fileInfo.size === cached.lastByteOffset && fileInfo.mtimeMs === cached.mtimeMs) {
      return null;
    }
    if (sameTranscriptFile(fileInfo, cached) && fileInfo.size > cached.lastByteOffset && await transcriptTailMatches(transcriptPath, cached)) {
      const incremental = await readIncrementalLatestTurns({ ...params, transcriptPath, fileInfo, cached });
      return incremental ?? null;
    }
  }

  return readFullSessionTurns({ ...params, transcriptPath, fileInfo });
}

async function readFullSessionTurns<Session extends AgentSession>(params: {
  transcriptPath: string;
  fileInfo: TranscriptFileInfo;
  readSession: ReadAgentSession<Session>;
  toTurnContent: ToTurnContent<Session>;
  toTurnOptions: ToTurnContentOptions;
  agent: string;
}): Promise<LatestTurnsResult | null> {
  const session = await params.readSession(params.transcriptPath, { artifactStore: defaultArtifactStore(), artifactMode: 'copy' });
  if (!session || session.turns.length === 0) {
    return null;
  }
  return {
    turns: captureTurnsFromSession(session, 0, params.toTurnContent, params.toTurnOptions),
    transcriptPath: params.transcriptPath,
    sessionKey: muninnSessionKey({ project: session.project, agent: params.agent, sessionId: session.sessionId }),
    progressEntry: await progressEntryFromSession(params.agent, session, params.transcriptPath, params.fileInfo, session.turns.length),
    markerAction: captureMarkerAction(session),
  };
}

async function readIncrementalLatestTurns<Session extends AgentSession>(params: {
  transcriptPath: string;
  fileInfo: TranscriptFileInfo;
  cached: CaptureProgressEntry;
  readSession: ReadAgentSession<Session>;
  toTurnContent: ToTurnContent<Session>;
  toTurnOptions: ToTurnContentOptions;
  agent: string;
}): Promise<LatestTurnsResult | null> {
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

  return {
    turns: captureTurnsFromSession(session, params.cached.nextTurnSequence, params.toTurnContent, params.toTurnOptions),
    transcriptPath: params.transcriptPath,
    sessionKey: muninnSessionKey({ project: session.project, agent: params.agent, sessionId: session.sessionId }),
    progressEntry: await progressEntryFromSession(
      params.agent,
      session,
      params.transcriptPath,
      params.fileInfo,
      params.cached.nextTurnSequence + session.turns.length,
    ),
    markerAction: captureMarkerAction(session),
  };
}

async function applyCaptureMarker<Session extends AgentSession>(params: {
  transcriptPath: string;
  readSession: ReadAgentSession<Session>;
  toTurnContent: ToTurnContent<Session>;
  toTurnOptions: ToTurnContentOptions;
  label: string;
  client?: MuninnClient;
  result: LatestTurnsResult;
  agent: string;
}): Promise<boolean> {
  await setSessionCapturePolicy(params.result.sessionKey, params.result.markerAction === 'enable');
  await removeCaptureProgressEntry(params.result.sessionKey);

  const identity = progressIdentity(params.result.progressEntry);
  const client = params.client ?? createMuninnClient({ config: resolveHookConfig(), label: params.label });
  if (params.result.markerAction === 'disable') {
    await client.deleteSession?.(identity);
    return false;
  }

  const fileInfo = await transcriptFileInfo(params.transcriptPath);
  const full = await readFullSessionTurns({
    transcriptPath: params.transcriptPath,
    fileInfo,
    readSession: params.readSession,
    toTurnContent: params.toTurnContent,
    toTurnOptions: params.toTurnOptions,
    agent: params.agent,
  });
  if (!full) {
    return false;
  }

  let captured = true;
  for (const turn of full.turns) {
    captured = await client.captureTurn({ turn }) && captured;
  }
  if (captured) {
    await writeCaptureProgressEntry(full.sessionKey, full.progressEntry).catch(() => undefined);
  }
  return captured;
}

function captureTurnsFromSession<Session extends AgentSession>(
  session: Session,
  startSequence: number,
  toTurnContent: ToTurnContent<Session>,
  options: ToTurnContentOptions,
): TurnContent[] {
  const turns: TurnContent[] = [];
  session.turns.forEach((turn, index) => {
    const sanitized = stripCaptureMarkersFromTurn(turn);
    if (!sanitized) {
      return;
    }
    turns.push(toTurnContent(session, sanitized, startSequence + index, options));
  });
  return turns;
}

function stripCaptureMarkersFromTurn<Turn extends AgentTurn>(turn: Turn): Turn | null {
  const stripped = stripCaptureMarkerLines(turn.response);
  if (stripped === turn.response) {
    return turn;
  }
  if (!stripped.trim()) {
    return null;
  }
  return { ...turn, response: stripped };
}

function captureMarkerAction(session: AgentSession): CaptureMarkerAction | null {
  const lastTurn = session.turns.at(-1);
  if (!lastTurn) {
    return null;
  }
  return captureMarkerActionFromText(lastTurn.response);
}

function captureMarkerActionFromText(value: string): CaptureMarkerAction | null {
  const actions = captureMarkerLines(value);
  return actions.length === 1 ? actions[0] : null;
}

function stripCaptureMarkerLines(value: string): string {
  const lines = value.split(/\r?\n/);
  const keep: string[] = [];
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      keep.push(line);
      continue;
    }
    if (!inFence && captureMarkerLine(trimmed)) {
      continue;
    }
    keep.push(line);
  }
  return keep.join('\n').trim();
}

function captureMarkerLines(value: string): CaptureMarkerAction[] {
  const actions: CaptureMarkerAction[] = [];
  let inFence = false;
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    const action = inFence ? null : captureMarkerLine(trimmed);
    if (action) {
      actions.push(action);
    }
  }
  return actions;
}

function captureMarkerLine(value: string): CaptureMarkerAction | null {
  const match = /^<MUNINN_CAPTURE_CURRENT_SESSION action="(enable|disable)" nonce="([^"]+)" \/>$/.exec(value);
  if (!match || match[2] !== CAPTURE_MARKER_NONCE) {
    return null;
  }
  return match[1] as CaptureMarkerAction;
}

async function readSessionFragment<Session extends AgentSession>(params: {
  content: string;
  transcriptPath: string;
  cached: CaptureProgressEntry;
  readSession: ReadAgentSession<Session>;
  agent: string;
}): Promise<Session | null> {
  const tempPath = path.join(
    path.dirname(params.transcriptPath),
    `muninn-transcript-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`,
  );
  const prefix = params.agent === CODEX_AGENT
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

async function progressEntryFromSession(
  agent: string,
  session: AgentSession,
  transcriptPath: string,
  fileInfo: TranscriptFileInfo,
  nextTurnSequence: number,
): Promise<CaptureProgressEntry> {
  return {
    agent,
    project: session.project,
    cwd: session.cwd,
    sessionId: session.sessionId,
    transcriptPath,
    byteOffset: fileInfo.size,
    lastTurnSequence: nextTurnSequence - 1,
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

function muninnHome(): string {
  return process.env.MUNINN_HOME ?? path.join(os.homedir(), '.muninn');
}

function capturePolicyPath(): string {
  return path.join(muninnHome(), 'capture.json');
}

function captureProgressPath(): string {
  const home = process.env.MUNINN_HOME ?? path.join(os.homedir(), '.muninn');
  return path.join(home, 'progress.json');
}

async function readCapturePolicy(): Promise<CapturePolicyFile> {
  try {
    const parsed = JSON.parse(await readFile(capturePolicyPath(), 'utf8')) as CapturePolicyFile;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Missing or malformed capture policy means disabled.
  }
  return {};
}

async function readCaptureProgress(): Promise<CaptureProgressFile> {
  try {
    const parsed = JSON.parse(await readFile(captureProgressPath(), 'utf8')) as CaptureProgressFile;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        sessions: parsed.sessions && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)
          ? parsed.sessions
          : {},
      };
    }
  } catch {
    // Create new progress below.
  }
  return { sessions: {} };
}

async function writeCaptureProgressEntry(sessionKey: string, entry: CaptureProgressEntry): Promise<void> {
  await withFileLock('capture-progress', async () => {
    const progress = await readCaptureProgress();
    progress.sessions ??= {};
    progress.sessions[sessionKey] = entry;
    await atomicWriteFile(captureProgressPath(), `${JSON.stringify(progress, null, 2)}\n`);
  });
}

async function removeCaptureProgressEntry(sessionKey: string): Promise<void> {
  await withFileLock('capture-progress', async () => {
    const progress = await readCaptureProgress();
    if (progress.sessions) {
      delete progress.sessions[sessionKey];
    }
    await atomicWriteFile(captureProgressPath(), `${JSON.stringify(progress, null, 2)}\n`);
  });
}

async function setSessionCapturePolicy(sessionKey: string, enabled: boolean): Promise<void> {
  await withFileLock('capture-policy', async () => {
    const policy = await readCapturePolicy();
    policy.capture ??= {};
    policy.capture.sessions ??= {};
    policy.capture.sessions[sessionKey] = enabled;
    await atomicWriteFile(capturePolicyPath(), `${JSON.stringify(policy, null, 2)}\n`);
  });
}

function progressIdentity(entry: CaptureProgressEntry): MuninnSessionIdentity {
  return {
    project: entry.project,
    agent: entry.agent,
    sessionId: entry.sessionId,
  };
}

async function isHookCaptureEnabled(sessionKey: string, entry: CaptureProgressEntry): Promise<boolean> {
  const policy = await readCapturePolicy();
  const capture = policy.capture;
  if (!capture) {
    return false;
  }
  const sessionPolicy = capture.sessions?.[sessionKey];
  if (sessionPolicy !== undefined) {
    return sessionPolicy === true;
  }
  return capture.agents?.[entry.agent] === true
    && capture.projects?.[entry.agent]?.[entry.project] === true;
}

function validCaptureProgressEntry(value: unknown, agent: string, transcriptPath: string): CaptureProgressEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const entry = value as Partial<CaptureProgressEntry>;
  if (
    entry.agent !== agent
    || typeof entry.project !== 'string'
    || typeof entry.cwd !== 'string'
    || typeof entry.sessionId !== 'string'
    || entry.transcriptPath !== transcriptPath
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
  return entry as CaptureProgressEntry;
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

function sameTranscriptFile(fileInfo: TranscriptFileInfo, cached: CaptureProgressEntry): boolean {
  return fileInfo.dev === cached.dev && fileInfo.ino === cached.ino;
}

async function transcriptTailMatches(transcriptPath: string, cached: CaptureProgressEntry): Promise<boolean> {
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
    // Lock disappeared after the handle closed.
  }
}

function lockOwnerAliveFromContent(content: string): boolean {
  const pid = Number(content.split(/\n/)[0]);
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function hashLockName(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveTimeoutMs(raw: string | undefined): number {
  const value = raw ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.trunc(value);
}

async function safeReadBody(response: FetchResponseLike): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return '';
  }
}

function logWarn(label: string, message: string, error?: unknown): void {
  const suffix = error instanceof Error ? `: ${error.message}` : error !== undefined ? `: ${String(error)}` : '';
  process.stderr.write(`[${label}] ${message}${suffix}\n`);
}
