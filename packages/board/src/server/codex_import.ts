import crypto from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addMessage, turns } from '@muninn/core';
import type {
  Artifact,
  CodexImportPreviewResponse,
  CodexImportProjectPreview,
  CodexImportRunResponse,
  CodexImportSessionPreview,
  TurnEvent,
  TurnContent,
} from '@muninn/types';

type CodexMessage = {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  artifacts: Artifact[];
};

type CodexTurn = {
  prompt: string;
  response: string;
  promptTimestamp: string;
  responseTimestamp: string;
  events: TurnEvent[];
  artifacts: Artifact[];
};

type CodexSession = {
  sessionId: string;
  cwd: string;
  projectKey: string;
  sourcePath: string;
  updatedAt: string;
  title: string;
  turns: CodexTurn[];
};

type ImportSelection = {
  sourceRoot: string;
  artifactStore: string;
  projectLimit: number;
  projects: CodexImportProjectPreview[];
  sessions: CodexSession[];
};

type ExistingImportTurn = {
  turnId: string;
  marker: string;
};

export type CodexImportOptions = {
  sourceRoot?: string;
  projectLimit?: number;
  projectKeys?: string[];
  artifactStore?: string;
};

const DEFAULT_PROJECT_LIMIT = 5;
const DEFAULT_PROJECT_KEYS = ['muninn', 'lance'];
const MUNINN_E2E_SESSION_TURN_LIMIT = 1_000;
const DELETE_BATCH_SIZE = 100;
const CODEX_IMPORT_AGENT = 'codex';
const IMPORT_ARTIFACT_KEY = 'codex.import';
const SMALL_TEXT_ARTIFACT_LIMIT = 16 * 1024;

export async function previewCodexImport(options: CodexImportOptions, requestId: string): Promise<CodexImportPreviewResponse> {
  const selection = await selectCodexImportSessions(options);
  return toPreviewResponse(selection, requestId);
}

export async function runCodexImport(options: CodexImportOptions, requestId: string): Promise<CodexImportRunResponse> {
  const selection = await selectCodexImportSessions(options);
  const selectedSessionIds = new Set(selection.sessions.map(importSessionId));
  const existingImports = await collectExistingCodexImports(selectedSessionIds);
  const existingImportTurns = [...existingImports.values()].flat();
  let importedSessions = 0;
  let importedTurns = 0;
  let skippedTurns = 0;
  let deletedTurns = await deleteExistingImport(existingImportTurns);
  const failedSessions: CodexImportRunResponse['failedSessions'] = [];

  for (const session of selection.sessions) {
    try {
      const result = await importCodexSession(session);
      if (result.importedTurns > 0 || result.skippedTurns > 0) {
        importedSessions += 1;
      }
      importedTurns += result.importedTurns;
      skippedTurns += result.skippedTurns;
    } catch (error) {
      failedSessions.push({
        sessionId: session.sessionId,
        sourcePath: session.sourcePath,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    ...toPreviewResponse(selection, requestId),
    deletedTurns,
    importedSessions,
    importedTurns,
    skippedTurns,
    failedSessions,
  };
}

async function selectCodexImportSessions(options: CodexImportOptions): Promise<ImportSelection> {
  const sourceRoot = options.sourceRoot ?? path.join(os.homedir(), '.codex');
  const artifactStore = options.artifactStore ?? defaultArtifactStore();
  const projectLimit = normalizeProjectLimit(options.projectLimit);
  const projectKeys = normalizeProjectKeys(options.projectKeys);
  const sessionFiles = await listCodexSessionFiles(sourceRoot);
  const sessions = (await Promise.all(sessionFiles.map((file) => readCodexSession(file, { artifactStore }))))
    .filter((session): session is CodexSession => session !== null)
    .filter((session) => projectKeys.has(session.projectKey))
    .filter((session) => !isExcludedImportSession(session))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  const grouped = new Map<string, CodexSession[]>();
  for (const session of sessions) {
    const existing = grouped.get(session.projectKey) ?? [];
    if (existing.length < projectLimit) {
      existing.push(session);
      grouped.set(session.projectKey, existing);
    }
  }

  const selected = [...grouped.values()].flat();
  const projects = [...grouped.entries()]
    .map(([projectKey, projectSessions]) => ({
      projectKey,
      cwd: projectSessions[0]?.cwd ?? '',
      sessions: projectSessions.map(toSessionPreview),
    }))
    .sort((left, right) => latestProjectTime(right).localeCompare(latestProjectTime(left)));

  return {
    sourceRoot,
    artifactStore,
    projectLimit,
    projects,
    sessions: selected,
  };
}

async function listCodexSessionFiles(sourceRoot: string): Promise<string[]> {
  const roots = [
    path.join(sourceRoot, 'sessions'),
    path.join(sourceRoot, 'archived_sessions'),
  ];
  const files: string[] = [];
  for (const root of roots) {
    files.push(...await listJsonlFiles(root));
  }
  return files;
}

async function listJsonlFiles(root: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listJsonlFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(entryPath);
    }
  }
  return files;
}

async function readCodexSession(sourcePath: string, options: { artifactStore: string }): Promise<CodexSession | null> {
  const content = await readFile(sourcePath, 'utf8');
  const fallbackUpdatedAt = (await stat(sourcePath)).mtime.toISOString();
  let sessionId = path.basename(sourcePath, '.jsonl');
  let cwd = os.homedir();
  let updatedAt = fallbackUpdatedAt;
  let isSubagentSession = false;
  const sessionTurns: CodexTurn[] = [];
  let promptParts: string[] = [];
  let promptTimestamp: string | null = null;
  let responseText: string | null = null;
  let responseTimestamp: string | null = null;
  let pendingArtifacts: Artifact[] = [];
  let pendingEvents: TurnEvent[] = [];

  const flushPendingTurn = () => {
    if (promptParts.length === 0 || !responseText) {
      return;
    }
    sessionTurns.push({
      prompt: promptParts.join('\n\n---\n\n'),
      response: responseText,
      promptTimestamp: promptTimestamp ?? responseTimestamp ?? updatedAt,
      responseTimestamp: responseTimestamp ?? promptTimestamp ?? updatedAt,
      events: pendingEvents.map((event) => ({ ...event })),
      artifacts: [...pendingArtifacts],
    });
    promptParts = [];
    promptTimestamp = null;
    responseText = null;
    responseTimestamp = null;
    pendingArtifacts = [];
    pendingEvents = [];
  };

  for (const [lineIndex, line] of content.split(/\n/).entries()) {
    if (!line.trim()) {
      continue;
    }
    const entry = safeParse(line);
    if (!entry) {
      continue;
    }

    if (entry.type === 'session_meta' && isRecord(entry.payload)) {
      sessionId = stringValue(entry.payload.id) ?? sessionId;
      cwd = stringValue(entry.payload.cwd) ?? cwd;
      updatedAt = stringValue(entry.payload.timestamp) ?? updatedAt;
      isSubagentSession = isSubagentSession || entry.payload.thread_source === 'subagent';
      isSubagentSession = isSubagentSession || hasSubagentSource(entry.payload.source);
      continue;
    }

    const toolCall = toolCallFromEntry(entry, lineIndex);
    if (toolCall) {
      if (promptParts.length > 0) {
        pendingEvents.push(toolCall);
      }
      continue;
    }

    const output = toolOutputFromEntry(entry);
    if (output) {
      if (promptParts.length > 0) {
        pendingEvents.push(output);
      }
      updatedAt = output.timestamp ?? updatedAt;
      continue;
    }

    const message = await messageFromEntry(entry, {
      artifactStore: options.artifactStore,
      artifactIndexStart: sessionTurns.length + promptParts.length,
    });
    if (message) {
      updatedAt = message.timestamp;
      if (message.role === 'user') {
        flushPendingTurn();
        promptTimestamp ??= message.timestamp;
        promptParts.push(message.text);
        pendingArtifacts.push(...message.artifacts);
        pendingEvents.push({
          type: 'userMessage',
          text: message.text,
          timestamp: message.timestamp,
          ...(message.artifacts.length > 0 ? { artifacts: message.artifacts } : {}),
        });
        continue;
      }
      if (promptParts.length === 0) {
        continue;
      }
      responseTimestamp = message.timestamp;
      responseText = message.text;
      pendingArtifacts.push(...message.artifacts);
      pendingEvents.push({
        type: 'assistantMessage',
        text: message.text,
        timestamp: message.timestamp,
        ...(message.artifacts.length > 0 ? { artifacts: message.artifacts } : {}),
      });
    }
  }
  flushPendingTurn();

  if (isSubagentSession) {
    return null;
  }

  if (sessionTurns.length === 0) {
    return null;
  }

  return {
    sessionId,
    cwd,
    projectKey: projectKeyFromCwd(cwd),
    sourcePath,
    updatedAt,
    title: titleFromTurns(sessionTurns, sessionId),
    turns: sessionTurns,
  };
}

async function messageFromEntry(
  entry: Record<string, unknown>,
  options: { artifactStore: string; artifactIndexStart: number },
): Promise<CodexMessage | null> {
  if (entry.type !== 'response_item' || !isRecord(entry.payload)) {
    return null;
  }
  if (entry.payload.type !== 'message') {
    return null;
  }
  const role = entry.payload.role;
  if (role !== 'user' && role !== 'assistant') {
    return null;
  }
  const content = await contentFromParts(entry.payload.content, {
    artifactStore: options.artifactStore,
    source: role === 'user' ? 'prompt' : 'response',
    keyPrefix: `${role}-${options.artifactIndexStart + 1}`,
  });
  const text = content.text;
  if (!text) {
    if (content.artifacts.length === 0) {
      return null;
    }
  }
  if (role === 'user' && text && isContextMessage(text)) {
    return null;
  }
  const fallbackText = content.artifacts.length > 0 ? '[Attachment]' : '';
  const displayText = text ?? fallbackText;
  const normalizedText = role === 'user' ? normalizeUserMessage(displayText) : displayText;
  if (!normalizedText) {
    return null;
  }
  return {
    role,
    text: normalizedText ?? '',
    timestamp: stringValue(entry.timestamp) ?? new Date().toISOString(),
    artifacts: content.artifacts,
  };
}

function hasSubagentSource(source: unknown): boolean {
  return isRecord(source) && isRecord(source.subagent);
}

function isContextMessage(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith('# AGENTS.md instructions')
    || trimmed.startsWith('<environment_context>')
    || trimmed.startsWith('<skill>')
    || trimmed.startsWith('<permissions instructions>')
    || trimmed.startsWith('The following is the Codex agent history whose request action you are assessing.')
    || trimmed.startsWith('The following is the Codex agent history added since your last approval assessment.');
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

async function contentFromParts(
  content: unknown,
  options: { artifactStore: string; source: Artifact['source']; keyPrefix: string },
): Promise<{ text: string | null; artifacts: Artifact[] }> {
  if (!Array.isArray(content)) {
    return { text: null, artifacts: [] };
  }

  const parts: string[] = [];
  const artifacts: Artifact[] = [];
  for (const [index, part] of content.entries()) {
    if (!isRecord(part)) {
      continue;
    }
    const text = stringValue(part.text);
    if (text) {
      parts.push(text);
    }
    const artifact = await artifactFromPart(part, {
      artifactStore: options.artifactStore,
      source: options.source,
      key: `${options.keyPrefix}-artifact-${index + 1}`,
    });
    if (artifact) {
      artifacts.push(artifact);
    }
  }
  const text = parts.join('\n\n').trim();
  return { text: text.length > 0 ? text : null, artifacts };
}

function toolCallFromEntry(entry: Record<string, unknown>, index: number): TurnEvent | null {
  if (entry.type !== 'response_item' || !isRecord(entry.payload) || entry.payload.type !== 'function_call') {
    return null;
  }
  const id = stringValue(entry.payload.call_id) ?? stringValue(entry.payload.id) ?? `call-${index + 1}`;
  const name = stringValue(entry.payload.name) ?? 'tool';
  const input = stringFromUnknown(entry.payload.arguments ?? entry.payload.input);
  return {
    type: 'toolCall',
    id,
    name,
    ...(input ? { input } : {}),
    ...(stringValue(entry.timestamp) ? { timestamp: stringValue(entry.timestamp)! } : {}),
  };
}

function toolOutputFromEntry(entry: Record<string, unknown>): TurnEvent | null {
  if (entry.type !== 'response_item' || !isRecord(entry.payload) || entry.payload.type !== 'function_call_output') {
    return null;
  }
  const id = stringValue(entry.payload.call_id) ?? stringValue(entry.payload.id);
  if (!id) {
    return null;
  }
  const output = stringFromUnknown(entry.payload.output ?? entry.payload.content);
  return {
    type: 'toolOutput',
    id,
    ...(output ? { output } : {}),
    ...(stringValue(entry.timestamp) ? { timestamp: stringValue(entry.timestamp)! } : {}),
  };
}

async function artifactFromPart(
  part: Record<string, unknown>,
  options: { artifactStore: string; source: Artifact['source']; key: string },
): Promise<Artifact | null> {
  const imageUrl = artifactUrl(part.image_url ?? part.imageUrl);
  if (imageUrl) {
    return imageArtifactFromUrl(imageUrl, options);
  }

  const filePath = stringValue(part.file_path) ?? stringValue(part.filePath) ?? stringValue(part.path);
  if (filePath) {
    return fileArtifactFromPath(filePath, options);
  }

  return null;
}

function artifactUrl(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  if (isRecord(value)) {
    return stringValue(value.url) ?? stringValue(value.path);
  }
  return null;
}

async function imageArtifactFromUrl(
  value: string,
  options: { artifactStore: string; source: Artifact['source']; key: string },
): Promise<Artifact> {
  if (value.startsWith('data:')) {
    const saved = await saveDataUrlArtifact(value, options.artifactStore);
    return {
      key: options.key,
      kind: 'image',
      source: options.source,
      uri: saved.uri,
      name: saved.name,
      mimeType: saved.mimeType,
      sizeBytes: saved.sizeBytes,
    };
  }

  if (value.startsWith('file://')) {
    return imageArtifactFromLocalPath(filePathFromFileUrl(value), options);
  }

  if (/^https?:\/\//i.test(value)) {
    return {
      key: options.key,
      kind: 'image',
      source: options.source,
      uri: value,
      name: path.basename(new URL(value).pathname) || 'image',
      mimeType: mimeTypeFromPath(value) ?? 'image/*',
    };
  }

  return imageArtifactFromLocalPath(value, options);
}

async function imageArtifactFromLocalPath(
  filePath: string,
  options: { artifactStore: string; source: Artifact['source']; key: string },
): Promise<Artifact> {
  const saved = await saveLocalFileArtifact(filePath, options.artifactStore);
  return {
    key: options.key,
    kind: 'image',
    source: options.source,
    uri: saved.uri,
    name: path.basename(filePath),
    mimeType: saved.mimeType ?? 'image/*',
    sizeBytes: saved.sizeBytes,
  };
}

async function fileArtifactFromPath(
  filePath: string,
  options: { artifactStore: string; source: Artifact['source']; key: string },
): Promise<Artifact> {
  if (/^https?:\/\//i.test(filePath)) {
    return {
      key: options.key,
      kind: mimeTypeFromPath(filePath)?.startsWith('image/') ? 'image' : 'file',
      source: options.source,
      uri: filePath,
      name: path.basename(new URL(filePath).pathname) || 'artifact',
      mimeType: mimeTypeFromPath(filePath),
    };
  }

  const localPath = filePath.startsWith('file://') ? filePathFromFileUrl(filePath) : filePath;
  const saved = await saveLocalFileArtifact(localPath, options.artifactStore);
  const kind = saved.mimeType?.startsWith('image/') ? 'image' : 'file';
  const artifact: Artifact = {
    key: options.key,
    kind,
    source: options.source,
    uri: saved.uri,
    name: path.basename(localPath),
    mimeType: saved.mimeType,
    sizeBytes: saved.sizeBytes,
  };
  if (kind === 'file' && saved.sizeBytes <= SMALL_TEXT_ARTIFACT_LIMIT && saved.mimeType?.startsWith('text/')) {
    artifact.content = await readFile(localPath, 'utf8');
  }
  return artifact;
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
  return writeArtifactBytes(payload, artifactStore, extensionForMimeType(mimeType), mimeType);
}

async function saveLocalFileArtifact(filePath: string, artifactStore: string): Promise<StoredArtifact> {
  const content = await readFile(filePath);
  const mimeType = mimeTypeFromPath(filePath);
  return writeArtifactBytes(content, artifactStore, path.extname(filePath), mimeType);
}

type StoredArtifact = {
  uri: string;
  name: string;
  mimeType?: string;
  sizeBytes: number;
};

async function writeArtifactBytes(
  content: Buffer,
  artifactStore: string,
  extension: string,
  mimeType?: string,
): Promise<StoredArtifact> {
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const safeExtension = extension && /^\.[a-z0-9]+$/i.test(extension) ? extension.toLowerCase() : '';
  const name = `${hash}${safeExtension}`;
  await mkdir(artifactStore, { recursive: true });
  const target = path.join(artifactStore, name);
  await writeFile(target, content);
  return {
    uri: `artifact://${name}`,
    name,
    mimeType,
    sizeBytes: content.byteLength,
  };
}

function filePathFromFileUrl(value: string): string {
  return decodeURIComponent(new URL(value).pathname);
}

function mimeTypeFromPath(value: string): string | undefined {
  const extension = path.extname(value).toLowerCase();
  switch (extension) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.md':
    case '.txt':
    case '.log':
      return 'text/plain';
    case '.json':
      return 'application/json';
    default:
      return undefined;
  }
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
    case 'text/plain':
      return '.txt';
    case 'application/json':
      return '.json';
    default:
      return '';
  }
}

function stringFromUnknown(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined || value === null) {
    return null;
  }
  return JSON.stringify(value);
}

async function importCodexSession(session: CodexSession): Promise<{ importedTurns: number; skippedTurns: number }> {
  let importedTurns = 0;
  let skippedTurns = 0;
  const importedMarkers = new Set<string>();
  for (const [index, turn] of session.turns.entries()) {
    const marker = importMarker(session, index);
    if (importedMarkers.has(marker)) {
      skippedTurns += 1;
      continue;
    }

    await addMessage(toTurnContent(session, turn, index));
    importedMarkers.add(marker);
    importedTurns += 1;
  }
  return { importedTurns, skippedTurns };
}

function toTurnContent(session: CodexSession, turn: CodexTurn, index: number): TurnContent {
  return {
    sessionId: importSessionId(session),
    agent: CODEX_IMPORT_AGENT,
    createdAt: turn.promptTimestamp,
    updatedAt: turn.responseTimestamp,
    title: promptTitle(turn.prompt),
    summary: turnSummary(turn),
    prompt: turn.prompt,
    response: turn.response,
    events: turn.events,
    artifacts: [{
      key: IMPORT_ARTIFACT_KEY,
      kind: 'metadata',
      source: 'import',
      content: JSON.stringify({
        marker: importMarker(session, index),
        project: session.projectKey,
        session: session.sessionId,
        source: session.sourcePath,
        cwd: session.cwd,
        timestamp: turn.responseTimestamp,
        promptTimestamp: turn.promptTimestamp,
        responseTimestamp: turn.responseTimestamp,
      }),
    }, ...turn.artifacts],
  };
}

async function collectExistingCodexImports(selectedSessionIds: Set<string>): Promise<Map<string, ExistingImportTurn[]>> {
  const existing = await turns.list({
    mode: { type: 'page', offset: 0, limit: 100_000 },
    agent: CODEX_IMPORT_AGENT,
  });
  const grouped = new Map<string, ExistingImportTurn[]>();
  for (const turn of existing) {
    let marker = markerFromTurn(turn);
    let sessionId = marker?.split('#', 1)[0] ?? '';
    if (!marker) {
      const legacySessionId = typeof turn.sessionId === 'string' ? turn.sessionId : '';
      if (!selectedSessionIds.has(legacySessionId)) {
        continue;
      }
      marker = `legacy:${turn.turnId}`;
      sessionId = legacySessionId;
    }
    if (!sessionId) {
      continue;
    }
    const turnsForSession = grouped.get(sessionId) ?? [];
    turnsForSession.push({ turnId: turn.turnId, marker });
    grouped.set(sessionId, turnsForSession);
  }
  return grouped;
}

async function deleteExistingImport(existing: ExistingImportTurn[]): Promise<number> {
  const turnIds = existing.map((turn) => turn.turnId);
  if (turnIds.length === 0) {
    return 0;
  }
  let deleted = 0;
  for (let index = 0; index < turnIds.length; index += DELETE_BATCH_SIZE) {
    deleted += (await turns.delete({ turnIds: turnIds.slice(index, index + DELETE_BATCH_SIZE) })).deleted;
  }
  return deleted;
}

function normalizeProjectLimit(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) {
    return DEFAULT_PROJECT_LIMIT;
  }
  return Math.min(Math.max(Math.floor(value), 1), 50);
}

function normalizeProjectKeys(value: string[] | undefined): Set<string> {
  const keys = value && value.length > 0 ? value : DEFAULT_PROJECT_KEYS;
  return new Set(keys.map((key) => key.trim()).filter((key) => key.length > 0));
}

function isExcludedImportSession(session: CodexSession): boolean {
  if (session.projectKey !== 'muninn') {
    return false;
  }
  return session.title.trim().toLowerCase() === 'e2e'
    || session.turns.length > MUNINN_E2E_SESSION_TURN_LIMIT;
}

function toPreviewResponse(selection: ImportSelection, requestId: string): CodexImportPreviewResponse {
  return {
    sourceRoot: selection.sourceRoot,
    projectLimit: selection.projectLimit,
    projectCount: selection.projects.length,
    sessionCount: selection.sessions.length,
    turnCount: selection.sessions.reduce((total, session) => total + session.turns.length, 0),
    artifactCount: selection.sessions.reduce((total, session) => (
      total + session.turns.reduce((sessionTotal, turn) => sessionTotal + turn.artifacts.length, 0)
    ), 0),
    projects: selection.projects,
    requestId,
  };
}

function toSessionPreview(session: CodexSession): CodexImportSessionPreview {
  return {
    sessionId: session.sessionId,
    title: session.title,
    cwd: session.cwd,
    sourcePath: session.sourcePath,
    updatedAt: session.updatedAt,
    turnCount: session.turns.length,
    artifactCount: session.turns.reduce((total, turn) => total + turn.artifacts.length, 0),
  };
}

function latestProjectTime(project: CodexImportProjectPreview): string {
  return project.sessions[0]?.updatedAt ?? '';
}

function importSessionId(session: CodexSession): string {
  return `${session.projectKey}/${slugify(session.title)}-${session.sessionId.slice(0, 8)}`;
}

function importMarker(session: CodexSession, turnIndex: number): string {
  return `${session.sessionId}#${turnIndex + 1}`;
}

function markerFromTurn(turn: { response?: string | null; artifacts?: Array<{ key: string; content?: string }> | null }): string | null {
  const artifact = turn.artifacts?.find((item) => item.key === IMPORT_ARTIFACT_KEY);
  if (artifact?.content) {
    const parsed = safeParse(artifact.content);
    if (parsed) {
      const marker = stringValue(parsed.marker);
      if (marker) {
        return marker;
      }
    }
  }

  const match = turn.response?.match(/<!--\s*muninn-codex-import:\s*([^>]+?)\s*-->/);
  return match ? match[1].trim() : null;
}

function titleFromTurns(turns: CodexTurn[], fallback: string): string {
  const first = turns[0]?.prompt.split(/\n/).find((line) => line.trim().length > 0)?.trim();
  return first ? truncate(first, 48) : fallback.slice(0, 12);
}

function promptTitle(prompt: string): string {
  const line = prompt.split(/\n/).find((item) => item.trim().length > 0)?.trim() ?? prompt.trim();
  return truncate(line, 100);
}

function turnSummary(turn: CodexTurn): string {
  return truncate(`${turn.prompt.trim()}\n\n${turn.response.trim()}`, 1_000);
}

function projectKeyFromCwd(cwd: string): string {
  const base = path.basename(cwd);
  return base || 'codex';
}

function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return truncate(normalized || 'session', 36);
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

function defaultArtifactStore(): string {
  const home = process.env.MUNINN_HOME ?? path.join(os.homedir(), '.muninn');
  return path.join(home, 'default', 'artifacts');
}

export const __testing = {
  readCodexSession,
  defaultArtifactStore,
};

export default {
  previewCodexImport,
  runCodexImport,
  __testing,
};
