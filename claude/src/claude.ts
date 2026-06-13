import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type { Artifact, TurnContent, TurnEvent } from '@muninn/common';
import { CLAUDE_AGENT } from '@muninn/common';
import type { ArtifactMode, ToTurnContentOptions } from '@muninn/common/agent-hook';

const execFileAsync = promisify(execFile);

export { CLAUDE_AGENT } from '@muninn/common';
export const CLAUDE_MARKER_KEY = 'claudeImport';

const SUMMARY_SCAN_MAX_LINES = 2_000;
const PROMPT_PREVIEW_LIMIT = 1_000;
const TIMESTAMP_TAIL_CHUNK_BYTES = 64 * 1024;

export type ClaudeTurn = {
  prompt: string;
  response: string;
  promptTimestamp: string;
  responseTimestamp: string;
  events: TurnEvent[];
  artifacts: Artifact[];
};

export type ClaudeSession = {
  sessionId: string;
  cwd: string;
  project: string;
  sourcePath: string;
  updatedAt: string;
  title: string;
  promptPreview?: string;
  turns: ClaudeTurn[];
};

export type ClaudeSessionSummary = Omit<ClaudeSession, 'turns'>;

export async function readClaudeSessionSummary(sourcePath: string): Promise<ClaudeSessionSummary | null> {
  const fallbackUpdatedAt = (await stat(sourcePath)).mtime.toISOString();
  let sessionId = path.basename(sourcePath, '.jsonl');
  let cwd = os.homedir();
  let title: string | null = null;
  let promptPreview: string | null = null;
  let sawAssistant = false;
  let scanned = 0;

  for await (const line of readJsonlLines(sourcePath)) {
    scanned += 1;
    if (scanned > SUMMARY_SCAN_MAX_LINES) {
      break;
    }
    if (!line.trim()) {
      continue;
    }
    const entry = safeParse(line);
    if (!entry || entry.isSidechain === true) {
      continue;
    }
    sessionId = stringValue(entry.sessionId) ?? sessionId;
    cwd = stringValue(entry.cwd) ?? cwd;

    const message = isRecord(entry.message) ? entry.message : null;
    if (entry.type === 'user' && message && !title) {
      const raw = message.content;
      if (typeof raw === 'string') {
        const prompt = summaryPromptFromText(raw);
        if (!prompt) {
          continue;
        }
        promptPreview = truncate(prompt, PROMPT_PREVIEW_LIMIT);
        title = titleFromPromptText(prompt, sessionId);
      }
    } else if (entry.type === 'assistant' && message && title) {
      const blocks = Array.isArray(message.content) ? message.content : [];
      sawAssistant = blocks.some((block) => isRecord(block) && block.type === 'text' && Boolean(stringValue(block.text)));
      if (sawAssistant) {
        break;
      }
    }
  }

  if (!title || !sawAssistant) {
    return null;
  }

  const project = await resolveProjectIdentity(cwd);
  const updatedAt = await latestTranscriptTimestamp(sourcePath, fallbackUpdatedAt);
  return {
    sessionId,
    cwd,
    project: project.project,
    sourcePath,
    updatedAt,
    title,
    ...(promptPreview ? { promptPreview } : {}),
  };
}

export async function readClaudeSession(
  sourcePath: string,
  options: { artifactStore: string; artifactMode?: ArtifactMode },
): Promise<ClaudeSession | null> {
  const content = await readFile(sourcePath, 'utf8');
  const fallbackUpdatedAt = (await stat(sourcePath)).mtime.toISOString();
  const artifactMode = options.artifactMode ?? 'copy';
  let sessionId = path.basename(sourcePath, '.jsonl');
  let cwd = os.homedir();
  let updatedAt = fallbackUpdatedAt;

  const sessionTurns: ClaudeTurn[] = [];
  let promptParts: string[] = [];
  let promptTimestamp: string | null = null;
  let responseParts: string[] = [];
  let responseTimestamp: string | null = null;
  let events: TurnEvent[] = [];
  let artifacts: Artifact[] = [];
  let artifactSeq = 0;

  const resetTurn = () => {
    promptParts = [];
    promptTimestamp = null;
    responseParts = [];
    responseTimestamp = null;
    events = [];
    artifacts = [];
  };
  const flush = () => {
    if (promptParts.length === 0 || responseParts.length === 0) {
      return;
    }
    const prompt = promptParts.join('\n\n').trim();
    const response = responseParts.join('\n\n').trim();
    if (!prompt || !response) {
      resetTurn();
      return;
    }
    sessionTurns.push({
      prompt,
      response,
      promptTimestamp: promptTimestamp ?? responseTimestamp ?? updatedAt,
      responseTimestamp: responseTimestamp ?? promptTimestamp ?? updatedAt,
      events: events.map((event) => ({ ...event })),
      artifacts: [...artifacts],
    });
    resetTurn();
  };

  const saveImages = async (blocks: unknown, source: Artifact['source']): Promise<void> => {
    if (!Array.isArray(blocks) || artifactMode !== 'copy') {
      return;
    }
    for (const block of blocks) {
      if (!isRecord(block) || block.type !== 'image') {
        continue;
      }
      const dataUrl = imageBlockToDataUrl(block.source);
      if (!dataUrl) {
        continue;
      }
      try {
        const saved = await saveDataUrlArtifact(dataUrl, options.artifactStore);
        artifactSeq += 1;
        artifacts.push({ key: `claude-image-${artifactSeq}`, kind: 'image', source, uri: saved.uri, name: saved.name, mimeType: saved.mimeType, sizeBytes: saved.sizeBytes });
      } catch {
        // Ignore unsavable image blocks.
      }
    }
  };

  for (const line of content.split(/\n/)) {
    if (!line.trim()) {
      continue;
    }
    const entry = safeParse(line);
    if (!entry || entry.isSidechain === true) {
      continue;
    }
    sessionId = stringValue(entry.sessionId) ?? sessionId;
    cwd = stringValue(entry.cwd) ?? cwd;
    const timestamp = stringValue(entry.timestamp);
    if (timestamp) {
      updatedAt = timestamp;
    }

    const message = isRecord(entry.message) ? entry.message : null;
    if (entry.type === 'user' && message) {
      const raw = message.content;
      if (typeof raw === 'string') {
        const text = raw.trim();
        if (!text) {
          continue;
        }
        flush();
        promptParts.push(text);
        promptTimestamp = timestamp ?? promptTimestamp;
        events.push({ type: 'userMessage', text, ...(timestamp ? { timestamp } : {}) });
      } else if (Array.isArray(raw) && promptParts.length > 0) {
        for (const block of raw) {
          if (!isRecord(block)) {
            continue;
          }
          if (block.type === 'tool_result') {
            const output = textFromContent(block.content);
            events.push({ type: 'toolOutput', ...(stringValue(block.tool_use_id) ? { id: stringValue(block.tool_use_id)! } : {}), ...(output ? { output } : {}), ...(timestamp ? { timestamp } : {}) });
            await saveImages(block.content, 'tool');
          } else if (block.type === 'image') {
            await saveImages([block], 'prompt');
          }
        }
      }
      continue;
    }

    if (entry.type === 'assistant' && message && promptParts.length > 0) {
      const blocks = Array.isArray(message.content) ? message.content : [];
      const textParts: string[] = [];
      for (const block of blocks) {
        if (!isRecord(block)) {
          continue;
        }
        if (block.type === 'text') {
          const text = stringValue(block.text);
          if (text) {
            textParts.push(text);
          }
        } else if (block.type === 'tool_use') {
          const name = stringValue(block.name) ?? 'tool';
          const input = block.input === undefined ? undefined : JSON.stringify(block.input);
          events.push({ type: 'toolCall', ...(stringValue(block.id) ? { id: stringValue(block.id)! } : {}), name, ...(input ? { input } : {}), ...(timestamp ? { timestamp } : {}) });
        }
      }
      if (textParts.length > 0) {
        const text = textParts.join('\n\n');
        responseParts.push(text);
        events.push({ type: 'assistantMessage', text, ...(timestamp ? { timestamp } : {}) });
      }
      if (timestamp) {
        responseTimestamp = timestamp;
      }
    }
  }
  flush();

  if (sessionTurns.length === 0) {
    return null;
  }

  const project = await resolveProjectIdentity(cwd);
  return {
    sessionId,
    cwd,
    project: project.project,
    sourcePath,
    updatedAt,
    title: titleFromTurns(sessionTurns, sessionId),
    turns: sessionTurns,
  };
}

export function toTurnContent(session: ClaudeSession, turn: ClaudeTurn, index: number, options: ToTurnContentOptions = {}): TurnContent {
  const markerKey = options.markerKey ?? CLAUDE_MARKER_KEY;
  const sourceTurnSequence = index;
  const metadata = {
    ingest: options.ingest ?? 'claude-code-import',
    sourcePath: session.sourcePath,
    sourceSessionId: session.sessionId,
    sourceTurnSequence,
    importedAt: new Date().toISOString(),
  };
  return {
    sessionId: session.sessionId,
    project: session.project,
    cwd: session.cwd,
    agent: options.agent ?? CLAUDE_AGENT,
    metadata,
    createdAt: turn.promptTimestamp,
    updatedAt: turn.responseTimestamp,
    summary: turnSummary(turn),
    prompt: turn.prompt,
    response: turn.response,
    events: turn.events,
    artifacts: [{
      key: markerKey,
      kind: 'metadata',
      source: 'import',
      content: JSON.stringify({
        marker: importMarker(session, index),
        ingest: metadata.ingest,
        project: session.project,
        session: session.sessionId,
        source: session.sourcePath,
        sourcePath: session.sourcePath,
        sourceSessionId: session.sessionId,
        sourceTurnSequence,
        importedAt: metadata.importedAt,
        cwd: session.cwd,
        timestamp: turn.responseTimestamp,
        promptTimestamp: turn.promptTimestamp,
        responseTimestamp: turn.responseTimestamp,
      }),
    }, ...turn.artifacts],
  };
}

export function importMarker(session: Pick<ClaudeSession, 'sessionId'>, turnIndex: number): string {
  return `${session.sessionId}#${turnIndex + 1}`;
}

function imageBlockToDataUrl(source: unknown): string | null {
  if (!isRecord(source) || source.type !== 'base64') {
    return null;
  }
  const mediaType = stringValue(source.media_type) ?? 'image/png';
  const data = stringValue(source.data);
  return data ? `data:${mediaType};base64,${data}` : null;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((block) => (isRecord(block) && block.type === 'text' ? stringValue(block.text) ?? '' : ''))
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

async function saveDataUrlArtifact(value: string, artifactStore: string): Promise<StoredArtifact> {
  const match = value.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/s);
  if (!match) {
    throw new Error('invalid data URL artifact');
  }
  const mimeType = match[1] || 'application/octet-stream';
  const payload = value.includes(';base64,')
    ? Buffer.from(match[2], 'base64')
    : Buffer.from(decodeURIComponent(match[2]), 'utf8');
  return writeArtifactBytes(payload, {
    artifactStore,
    sessionId: 'shared',
    agent: CLAUDE_AGENT,
    timestamp: new Date().toISOString(),
    originalName: 'image',
    extension: extensionForMimeType(mimeType),
    mimeType,
  });
}

type StoredArtifact = {
  uri: string;
  name: string;
  mimeType?: string;
  sizeBytes: number;
};

async function writeArtifactBytes(
  content: Buffer,
  options: { artifactStore: string; sessionId: string; agent: string; timestamp: string; originalName: string; extension: string; mimeType?: string },
): Promise<StoredArtifact> {
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const safeExtension = options.extension && /^\.[a-z0-9]+$/i.test(options.extension) ? options.extension.toLowerCase() : '';
  const originalBase = path.basename(options.originalName, path.extname(options.originalName));
  const safeBase = safeFilenamePart(originalBase || 'artifact');
  const timestamp = timestampForFilename(options.timestamp);
  const sessionDir = `sessions/${safeFilenamePart(`${options.agent}-${options.sessionId}`)}`;
  let name = `${safeBase}-${timestamp}${safeExtension}`;
  let relativePath = `${sessionDir}/${name}`;
  let target = path.join(options.artifactStore, relativePath);
  try {
    await stat(target);
    name = `${safeBase}-${timestamp}-${hash.slice(0, 6)}${safeExtension}`;
    relativePath = `${sessionDir}/${name}`;
    target = path.join(options.artifactStore, relativePath);
  } catch {
    // No conflict.
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  return {
    uri: `artifact://${relativePath}`,
    name,
    mimeType: options.mimeType,
    sizeBytes: content.byteLength,
  };
}

function safeFilenamePart(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .toLowerCase();
  return normalized || 'artifact';
}

function timestampForFilename(value: string): string {
  const date = new Date(value);
  const source = Number.isNaN(date.getTime()) ? new Date() : date;
  return source.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    case 'image/svg+xml':
      return '.svg';
    default:
      return '';
  }
}

function titleFromTurns(turns: ClaudeTurn[], fallback: string): string {
  const first = turns[0] ? displayTitleFromPrompt(turns[0].prompt) : '';
  return first || fallback.slice(0, 12);
}

function titleFromPromptText(prompt: string | null, fallback: string): string {
  const title = prompt ? displayTitleFromPrompt(prompt) : '';
  return title || fallback.slice(0, 12);
}

function summaryPromptFromText(text: string | null): string | null {
  if (!text || isContextMessage(text)) {
    return null;
  }
  return normalizeUserMessage(text);
}

const WRAPPER_TAGS = /<\/?(?:command-[a-z-]+|local-command-[a-z-]+|system-reminder)>/gi;

function displayTitleFromPrompt(prompt: string): string {
  const cleaned = prompt.replace(WRAPPER_TAGS, '');
  const line = cleaned.split(/\n/).map((value) => value.trim()).find((value) => value.length > 0) ?? cleaned.trim();
  return truncate(line, 80);
}

function turnSummary(turn: ClaudeTurn): string {
  return truncate(`${turn.prompt.trim()}\n\n${turn.response.trim()}`, 1_000);
}

function isContextMessage(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith('# AGENTS.md instructions')
    || trimmed.startsWith('<environment_context>')
    || trimmed.startsWith('<skill>')
    || trimmed.startsWith('<permissions instructions>');
}

function normalizeUserMessage(text: string): string | null {
  const withoutAborted = text
    .replace(/<turn_aborted>[\s\S]*?<\/turn_aborted>/g, '')
    .replace(/(?:^|\n)\s*---\s*(?=\n|$)/g, '\n')
    .trim();
  const requestMarker = '## My request for Codex:';
  const requestIndex = withoutAborted.lastIndexOf(requestMarker);
  const normalized = requestIndex >= 0
    ? withoutAborted.slice(requestIndex + requestMarker.length).trim()
    : withoutAborted;
  return normalized.length > 0 ? normalized : null;
}

export type ProjectIdentity = {
  project: string;
};

export async function resolveProjectIdentity(cwd: string): Promise<ProjectIdentity> {
  const fallback = await realpathOrResolved(cwd || os.homedir());
  try {
    const { stdout: topLevelStdout } = await execFileAsync('git', ['-C', fallback, 'rev-parse', '--show-toplevel']);
    const topLevelRaw = topLevelStdout.trim();
    if (!topLevelRaw) {
      return { project: fallback };
    }
    const topLevel = await realpathOrResolved(topLevelRaw);
    const { stdout: commonDirStdout } = await execFileAsync('git', ['-C', fallback, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    const commonDirRaw = commonDirStdout.trim();
    if (!commonDirRaw) {
      return { project: await resolveGithubProjectIdentity(topLevel) ?? topLevel };
    }
    const commonDir = await realpathOrResolved(commonDirRaw);
    const canonical = commonDir.endsWith(`${path.sep}.git`) ? path.dirname(commonDir) : topLevel;
    return { project: await resolveGithubProjectIdentity(canonical) ?? canonical };
  } catch {
    return { project: fallback };
  }
}

async function resolveGithubProjectIdentity(repoPath: string): Promise<string | null> {
  for (const remote of ['origin', 'upstream']) {
    try {
      const { stdout } = await execFileAsync('git', ['-C', repoPath, 'remote', 'get-url', remote]);
      const identity = githubProjectFromRemoteUrl(stdout.trim());
      if (identity) {
        return identity;
      }
    } catch {
      // Try the next remote.
    }
  }
  return null;
}

function githubProjectFromRemoteUrl(remoteUrl: string): string | null {
  const value = remoteUrl.trim();
  if (!value) {
    return null;
  }
  if (!value.includes('://')) {
    const scpMatch = value.match(/^(?:[^@]+@)?github\.com:([^/\s]+)\/(.+)$/i);
    if (scpMatch) {
      return githubProjectIdentity(scpMatch[1], scpMatch[2]);
    }
  }
  try {
    const parsed = new URL(value);
    if (parsed.hostname.toLowerCase() !== 'github.com') {
      return null;
    }
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length !== 2) {
      return null;
    }
    return githubProjectIdentity(parts[0], parts[1]);
  } catch {
    return null;
  }
}

function githubProjectIdentity(owner: string, repo: string): string | null {
  const normalizedOwner = owner.trim().toLowerCase();
  const normalizedRepo = repo.trim().replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
  if (!normalizedOwner || !normalizedRepo || normalizedOwner.includes('/') || normalizedRepo.includes('/')) {
    return null;
  }
  return `github.com/${normalizedOwner}/${normalizedRepo}`;
}

async function realpathOrResolved(value: string): Promise<string> {
  const resolved = path.resolve(value);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

async function* readJsonlLines(sourcePath: string): AsyncGenerator<string> {
  const input = createReadStream(sourcePath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      yield line;
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

async function latestTranscriptTimestamp(sourcePath: string, fallback: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(sourcePath, 'r');
    const { size } = await handle.stat();
    let position = size;
    let partial = '';
    while (position > 0) {
      const readSize = Math.min(TIMESTAMP_TAIL_CHUNK_BYTES, position);
      position -= readSize;
      const buffer = Buffer.allocUnsafe(readSize);
      const { bytesRead } = await handle.read(buffer, 0, readSize, position);
      partial = `${buffer.subarray(0, bytesRead).toString('utf8')}${partial}`;
      const lines = partial.split(/\n/);
      partial = lines.shift() ?? '';
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const timestamp = timestampFromJsonlLine(lines[index]);
        if (timestamp) {
          return timestamp;
        }
      }
    }
    return timestampFromJsonlLine(partial) ?? fallback;
  } catch {
    return fallback;
  } finally {
    await handle?.close();
  }
}

function timestampFromJsonlLine(line: string): string | null {
  if (!line.trim()) {
    return null;
  }
  return timestampFromTranscriptEntry(safeParse(line));
}

function timestampFromTranscriptEntry(entry: unknown): string | null {
  if (!isRecord(entry)) {
    return null;
  }
  return stringValue(entry.timestamp);
}

async function atomicWriteFile(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmpPath = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(tmpPath, content, 'utf8');
  await rename(tmpPath, file);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength).trimEnd() : value;
}

function safeParse(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
