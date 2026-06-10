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

type ArtifactMode = 'preview' | 'copy';
type ArtifactWriteOptions = {
  artifactStore: string;
  artifactMode: ArtifactMode;
  sessionId: string;
  agent: string;
  source: Artifact['source'];
  key: string;
  timestamp: string;
  baseDirs: string[];
};
type PendingToolCall = {
  name: string;
  input: string | null;
  timestamp: string;
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
  const selection = await selectCodexImportSessions(options, 'preview');
  return toPreviewResponse(selection, requestId);
}

export async function runCodexImport(options: CodexImportOptions, requestId: string): Promise<CodexImportRunResponse> {
  const selection = await selectCodexImportSessions(options, 'preview');
  const selectedRawSessionIds = new Set(selection.sessions.map((session) => session.sessionId));
  const existingImports = await collectExistingCodexImports({
    rawSessionIds: selectedRawSessionIds,
  });
  const existingImportTurns = [...existingImports.values()].flat();
  let importedSessions = 0;
  let importedTurns = 0;
  let skippedTurns = 0;
  let deletedTurns = await deleteExistingImport(existingImportTurns);
  const failedSessions: CodexImportRunResponse['failedSessions'] = [];

  for (const previewSession of selection.sessions) {
    try {
      const session = await readCodexSession(previewSession.sourcePath, {
        artifactStore: selection.artifactStore,
        artifactMode: 'copy',
      });
      if (!session) {
        continue;
      }
      const result = await importCodexSession(session);
      if (result.importedTurns > 0 || result.skippedTurns > 0) {
        importedSessions += 1;
      }
      importedTurns += result.importedTurns;
      skippedTurns += result.skippedTurns;
    } catch (error) {
      failedSessions.push({
        sessionId: previewSession.sessionId,
        sourcePath: previewSession.sourcePath,
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

async function selectCodexImportSessions(options: CodexImportOptions, artifactMode: ArtifactMode): Promise<ImportSelection> {
  const sourceRoot = options.sourceRoot ?? path.join(os.homedir(), '.codex');
  const artifactStore = options.artifactStore ?? defaultArtifactStore();
  const projectLimit = normalizeProjectLimit(options.projectLimit);
  const projectKeys = normalizeProjectKeys(options.projectKeys);
  const sessionFiles = await listCodexSessionFiles(sourceRoot);
  const sessions = (await Promise.all(sessionFiles.map((file) => readCodexSession(file, { artifactStore, artifactMode }))))
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

async function readCodexSession(sourcePath: string, options: { artifactStore: string; artifactMode?: ArtifactMode }): Promise<CodexSession | null> {
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
  let toolCallsById = new Map<string, PendingToolCall>();

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
    toolCallsById = new Map();
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

    const artifactBase = {
      artifactStore: options.artifactStore,
      artifactMode: options.artifactMode ?? 'copy',
      sessionId,
      agent: CODEX_IMPORT_AGENT,
      baseDirs: [cwd, path.dirname(sourcePath)],
    };

    const toolCall = toolCallFromEntry(entry, lineIndex);
    if (toolCall) {
      if (promptParts.length > 0) {
        pendingEvents.push(toolCall);
        if (toolCall.id) {
          toolCallsById.set(toolCall.id, {
            name: toolCall.name,
            input: toolCall.input ?? null,
            timestamp: toolCall.timestamp ?? updatedAt,
          });
        }
      }
      continue;
    }

    const output = await toolOutputFromEntry(entry, {
      ...artifactBase,
      timestamp: stringValue(entry.timestamp) ?? updatedAt,
      fallbackArtifacts: async (id) => {
        const call = toolCallsById.get(id);
        if (!call) {
          return [];
        }
        return artifactsFromToolCall(call.name, call.input, {
          ...artifactBase,
          source: 'tool',
          keyPrefix: `${id}-input`,
          timestamp: call.timestamp,
        });
      },
    });
    if (output) {
      if (promptParts.length > 0) {
        pendingEvents.push(output);
        if (output.type === 'toolOutput' && output.artifacts && output.artifacts.length > 0) {
          pendingArtifacts.push(...output.artifacts);
        }
      }
      updatedAt = output.timestamp ?? updatedAt;
      continue;
    }

    const message = await messageFromEntry(entry, {
      artifactStore: options.artifactStore,
      artifactMode: options.artifactMode ?? 'copy',
      artifactIndexStart: sessionTurns.length + promptParts.length,
      sessionId,
      agent: CODEX_IMPORT_AGENT,
      timestamp: stringValue(entry.timestamp) ?? updatedAt,
      baseDirs: [cwd, path.dirname(sourcePath)],
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
  options: {
    artifactStore: string;
    artifactMode: ArtifactMode;
    artifactIndexStart: number;
    sessionId: string;
    agent: string;
    timestamp: string;
    baseDirs: string[];
  },
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
    artifactMode: options.artifactMode,
    sessionId: options.sessionId,
    agent: options.agent,
    source: role === 'user' ? 'prompt' : 'response',
    keyPrefix: `${role}-${options.artifactIndexStart + 1}`,
    timestamp: options.timestamp,
    baseDirs: options.baseDirs,
  });
  if (content.text) {
    content.artifacts.push(...await artifactsFromMarkdownText(content.text, {
      artifactStore: options.artifactStore,
      artifactMode: options.artifactMode,
      sessionId: options.sessionId,
      agent: options.agent,
      source: role === 'user' ? 'prompt' : 'response',
      keyPrefix: `${role}-${options.artifactIndexStart + 1}-link`,
      timestamp: options.timestamp,
      baseDirs: options.baseDirs,
    }));
  }
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
  options: {
    artifactStore: string;
    artifactMode: ArtifactMode;
    sessionId: string;
    agent: string;
    source: Artifact['source'];
    keyPrefix: string;
    timestamp: string;
    baseDirs: string[];
  },
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
      artifactMode: options.artifactMode,
      sessionId: options.sessionId,
      agent: options.agent,
      source: options.source,
      key: `${options.keyPrefix}-artifact-${index + 1}`,
      timestamp: options.timestamp,
      baseDirs: options.baseDirs,
    });
    if (artifact) {
      artifacts.push(artifact);
    }
  }
  const text = parts.join('\n\n').trim();
  return { text: text.length > 0 ? text : null, artifacts };
}

function toolCallFromEntry(entry: Record<string, unknown>, index: number): Extract<TurnEvent, { type: 'toolCall' }> | null {
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

async function toolOutputFromEntry(
  entry: Record<string, unknown>,
  options: {
    artifactStore: string;
    artifactMode: ArtifactMode;
    sessionId: string;
    agent: string;
    timestamp: string;
    baseDirs: string[];
    fallbackArtifacts: (id: string) => Promise<Artifact[]>;
  },
): Promise<TurnEvent | null> {
  if (entry.type !== 'response_item' || !isRecord(entry.payload) || entry.payload.type !== 'function_call_output') {
    return null;
  }
  const id = stringValue(entry.payload.call_id) ?? stringValue(entry.payload.id);
  if (!id) {
    return null;
  }
  const rawOutput = entry.payload.output ?? entry.payload.content;
  let output = stringFromUnknown(rawOutput);
  let artifacts: Artifact[] = [];
  if (Array.isArray(rawOutput)) {
    const content = await contentFromParts(rawOutput, {
      artifactStore: options.artifactStore,
      artifactMode: options.artifactMode,
      sessionId: options.sessionId,
      agent: options.agent,
      source: 'tool',
      keyPrefix: `${id}-output`,
      timestamp: options.timestamp,
      baseDirs: options.baseDirs,
    });
    output = content.text;
    artifacts = content.artifacts;
  }
  if (artifacts.length === 0) {
    artifacts = await options.fallbackArtifacts(id);
  }
  return {
    type: 'toolOutput',
    id,
    ...(output ? { output } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(stringValue(entry.timestamp) ? { timestamp: stringValue(entry.timestamp)! } : {}),
  };
}

async function artifactFromPart(
  part: Record<string, unknown>,
  options: {
    artifactStore: string;
    artifactMode: ArtifactMode;
    sessionId: string;
    agent: string;
    source: Artifact['source'];
    key: string;
    timestamp: string;
    baseDirs: string[];
  },
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

async function artifactsFromToolCall(
  name: string,
  input: string | null,
  options: Omit<ArtifactWriteOptions, 'key'> & { keyPrefix: string },
): Promise<Artifact[]> {
  if (!input) {
    return [];
  }
  const parsed = safeParse(input);
  if (!parsed) {
    return [];
  }

  const candidates: string[] = [];
  if (name === 'view_image') {
    const imagePath = stringValue(parsed.path) ?? stringValue(parsed.file_path) ?? stringValue(parsed.filePath);
    if (imagePath) {
      candidates.push(imagePath);
    }
  }

  if (name === 'apply_patch') {
    const patch = stringValue(parsed.patch);
    if (patch) {
      candidates.push(...pathsFromApplyPatch(patch));
    }
  }

  const artifacts: Artifact[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const artifact = await fileArtifactFromPath(candidate, {
      ...options,
      key: `${options.keyPrefix}-artifact-${index + 1}`,
    });
    if (artifact) {
      artifacts.push(artifact);
    }
  }
  return artifacts;
}

async function artifactsFromMarkdownText(
  text: string,
  options: Omit<ArtifactWriteOptions, 'key'> & { keyPrefix: string },
): Promise<Artifact[]> {
  const candidates = pathsFromMarkdownLinks(text);
  const artifacts: Artifact[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const artifact = await fileArtifactFromPath(candidate, {
      ...options,
      key: `${options.keyPrefix}-artifact-${index + 1}`,
    });
    if (artifact) {
      artifacts.push(artifact);
    }
  }
  return artifacts;
}

function pathsFromMarkdownLinks(text: string): string[] {
  const paths: string[] = [];
  const markdownLinkPattern = /!?\[[^\]]*]\(([^)\s]+(?:\s[^)]*?)?)\)/g;
  for (const match of text.matchAll(markdownLinkPattern)) {
    const value = cleanMarkdownUrl(match[1]);
    if (value && isImportArtifactCandidate(value)) {
      paths.push(value);
    }
  }
  const fileUrlPattern = /\bfile:\/\/[^\s)]+/g;
  for (const match of text.matchAll(fileUrlPattern)) {
    if (isImportArtifactCandidate(match[0])) {
      paths.push(match[0]);
    }
  }
  return [...new Set(paths)];
}

function cleanMarkdownUrl(value: string): string | null {
  const trimmed = value.trim();
  const quoted = trimmed.match(/^["'](.+)["']$/);
  const withoutTitle = (quoted?.[1] ?? trimmed).split(/\s+["'][^"']*["']\s*$/)[0] ?? trimmed;
  return safeDecodeURI(withoutTitle.trim());
}

function safeDecodeURI(value: string): string | null {
  try {
    return decodeURI(value);
  } catch {
    return null;
  }
}

function pathsFromApplyPatch(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split(/\n/)) {
    const match = line.match(/^\*\*\* (?:Add File|Update File|Move to):\s+(.+?)\s*$/);
    if (match && isImportArtifactCandidate(match[1])) {
      paths.push(match[1]);
    }
  }
  return [...new Set(paths)];
}

function isImportArtifactCandidate(value: string): boolean {
  if (!value || /^https?:\/\//i.test(value) || value.startsWith('artifact://')) {
    return false;
  }
  const target = value.startsWith('file://') ? tryFilePathFromFileUrl(value) : value;
  if (!target) {
    return false;
  }
  const extension = path.extname(target).toLowerCase();
  return [
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.svg',
    '.md',
    '.html',
    '.htm',
    '.txt',
    '.log',
    '.json',
  ].includes(extension);
}

async function imageArtifactFromUrl(
  value: string,
  options: {
    artifactStore: string;
    artifactMode: ArtifactMode;
    sessionId: string;
    agent: string;
    source: Artifact['source'];
    key: string;
    timestamp: string;
    baseDirs: string[];
  },
): Promise<Artifact | null> {
  if (options.artifactMode === 'preview') {
    return {
      key: options.key,
      kind: 'image',
      source: options.source,
      name: artifactNameFromValue(value, 'image'),
      mimeType: mimeTypeFromPath(value) ?? 'image/*',
    };
  }

  if (value.startsWith('data:')) {
    const saved = await trySaveDataUrlArtifact(value, options);
    if (!saved) {
      return null;
    }
    return {
      key: options.key,
      kind: 'image',
      source: options.source,
      uri: saved.uri,
      name: artifactNameFromValue(value, 'image'),
      mimeType: saved.mimeType,
      sizeBytes: saved.sizeBytes,
    };
  }

  if (value.startsWith('file://')) {
    const localPath = tryFilePathFromFileUrl(value);
    return localPath ? imageArtifactFromLocalPath(localPath, options) : null;
  }

  if (/^https?:\/\//i.test(value)) {
    const name = artifactNameFromHttpUrl(value);
    if (!name) {
      return null;
    }
    return {
      key: options.key,
      kind: 'image',
      source: options.source,
      uri: value,
      name,
      mimeType: mimeTypeFromPath(value) ?? 'image/*',
    };
  }

  return imageArtifactFromLocalPath(value, options);
}

async function imageArtifactFromLocalPath(
  filePath: string,
  options: ArtifactWriteOptions,
): Promise<Artifact | null> {
  const resolved = await resolveLocalArtifactPath(filePath, options.baseDirs);
  if (!resolved) {
    return null;
  }
  const saved = await saveLocalFileArtifact(resolved, options);
  return {
    key: options.key,
    kind: 'image',
    source: options.source,
    uri: saved.uri,
    name: path.basename(resolved),
    mimeType: saved.mimeType ?? 'image/*',
    sizeBytes: saved.sizeBytes,
  };
}

async function fileArtifactFromPath(
  filePath: string,
  options: {
    artifactStore: string;
    artifactMode: ArtifactMode;
    sessionId: string;
    agent: string;
    source: Artifact['source'];
    key: string;
    timestamp: string;
    baseDirs: string[];
  },
): Promise<Artifact | null> {
  if (/^https?:\/\//i.test(filePath)) {
    const name = artifactNameFromHttpUrl(filePath);
    if (!name) {
      return null;
    }
    return {
      key: options.key,
      kind: mimeTypeFromPath(filePath)?.startsWith('image/') ? 'image' : 'file',
      source: options.source,
      uri: filePath,
      name,
      mimeType: mimeTypeFromPath(filePath),
    };
  }

  const localPath = filePath.startsWith('file://') ? tryFilePathFromFileUrl(filePath) : filePath;
  if (!localPath) {
    return null;
  }
  if (options.artifactMode === 'preview') {
    return {
      key: options.key,
      kind: mimeTypeFromPath(localPath)?.startsWith('image/') ? 'image' : 'file',
      source: options.source,
      name: path.basename(localPath),
      mimeType: mimeTypeFromPath(localPath),
    };
  }

  const resolved = await resolveLocalArtifactPath(localPath, options.baseDirs);
  if (!resolved) {
    return null;
  }
  const saved = await saveLocalFileArtifact(resolved, options);
  const kind = saved.mimeType?.startsWith('image/') ? 'image' : 'file';
  const artifact: Artifact = {
    key: options.key,
    kind,
    source: options.source,
    uri: saved.uri,
    name: path.basename(resolved),
    mimeType: saved.mimeType,
    sizeBytes: saved.sizeBytes,
  };
  if (kind === 'file' && saved.sizeBytes <= SMALL_TEXT_ARTIFACT_LIMIT && saved.mimeType?.startsWith('text/')) {
    artifact.content = await readFile(resolved, 'utf8');
  }
  return artifact;
}

async function saveDataUrlArtifact(value: string, options: ArtifactWriteOptions): Promise<StoredArtifact> {
  const match = value.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/s);
  if (!match) {
    throw new Error('invalid data URL artifact');
  }
  const mimeType = match[1] || 'application/octet-stream';
  const payload = value.includes(';base64,')
    ? Buffer.from(match[2], 'base64')
    : Buffer.from(decodeURIComponent(match[2]), 'utf8');
  return writeArtifactBytes(payload, {
    ...options,
    originalName: artifactNameFromValue(value, 'image'),
    extension: extensionForMimeType(mimeType),
    mimeType,
  });
}

async function trySaveDataUrlArtifact(value: string, options: ArtifactWriteOptions): Promise<StoredArtifact | null> {
  try {
    return await saveDataUrlArtifact(value, options);
  } catch {
    return null;
  }
}

async function saveLocalFileArtifact(filePath: string, options: ArtifactWriteOptions): Promise<StoredArtifact> {
  const content = await readFile(filePath);
  const mimeType = mimeTypeFromPath(filePath);
  return writeArtifactBytes(content, {
    ...options,
    originalName: path.basename(filePath),
    extension: path.extname(filePath),
    mimeType,
  });
}

async function resolveLocalArtifactPath(filePath: string, baseDirs: string[]): Promise<string | null> {
  const candidates = path.isAbsolute(filePath)
    ? [filePath]
    : [
      ...baseDirs.map((baseDir) => path.resolve(baseDir, filePath)),
      path.resolve(filePath),
    ];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

type StoredArtifact = {
  uri: string;
  name: string;
  mimeType?: string;
  sizeBytes: number;
};

async function writeArtifactBytes(
  content: Buffer,
  options: ArtifactWriteOptions & { originalName: string; extension: string; mimeType?: string },
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

function filePathFromFileUrl(value: string): string {
  return decodeURIComponent(new URL(value).pathname);
}

function tryFilePathFromFileUrl(value: string): string | null {
  try {
    return filePathFromFileUrl(value);
  } catch {
    return null;
  }
}

function artifactNameFromValue(value: string, fallback: string): string {
  try {
    if (/^https?:\/\//i.test(value)) {
      return path.basename(new URL(value).pathname) || fallback;
    }
  } catch {
    return fallback;
  }
  if (value.startsWith('data:')) {
    return fallback;
  }
  const localPath = value.startsWith('file://') ? tryFilePathFromFileUrl(value) : value;
  if (!localPath) {
    return fallback;
  }
  return path.basename(localPath) || fallback;
}

function artifactNameFromHttpUrl(value: string): string | null {
  try {
    return path.basename(new URL(value).pathname) || 'artifact';
  } catch {
    return null;
  }
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
      return 'text/plain';
    case '.html':
    case '.htm':
      return 'text/html';
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
    case 'text/html':
      return '.html';
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
  const metadata = {
    ingest: 'codex-import',
    sourcePath: session.sourcePath,
    sourceSessionId: session.sessionId,
    importedAt: new Date().toISOString(),
  };
  return {
    sessionId: session.sessionId,
    project: session.projectKey,
    cwd: session.cwd,
    agent: CODEX_IMPORT_AGENT,
    metadata,
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
        ingest: metadata.ingest,
        project: session.projectKey,
        session: session.sessionId,
        source: session.sourcePath,
        sourcePath: session.sourcePath,
        sourceSessionId: session.sessionId,
        importedAt: metadata.importedAt,
        cwd: session.cwd,
        timestamp: turn.responseTimestamp,
        promptTimestamp: turn.promptTimestamp,
        responseTimestamp: turn.responseTimestamp,
      }),
    }, ...turn.artifacts],
  };
}

async function collectExistingCodexImports(selected: {
  rawSessionIds: Set<string>;
}): Promise<Map<string, ExistingImportTurn[]>> {
  const existing = await turns.list({
    mode: { type: 'page', offset: 0, limit: 100_000 },
    agent: CODEX_IMPORT_AGENT,
  });
  const grouped = new Map<string, ExistingImportTurn[]>();
  for (const turn of existing) {
    let marker = markerFromTurn(turn);
    let sessionId = marker?.split('#', 1)[0] ?? '';
    if (!marker) {
      continue;
    }
    if (!selected.rawSessionIds.has(sessionId)) {
      continue;
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
