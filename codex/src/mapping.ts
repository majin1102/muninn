import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type { Artifact, TurnContent, TurnEvent } from '@muninn/common';

const execFileAsync = promisify(execFile);

export type CodexMessage = {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  artifacts: Artifact[];
};

export type CodexTurn = {
  prompt: string;
  response: string;
  promptTimestamp: string;
  responseTimestamp: string;
  events: TurnEvent[];
  artifacts: Artifact[];
};

export type CodexSession = {
  sessionId: string;
  cwd: string;
  project: string;
  sourcePath: string;
  updatedAt: string;
  title: string;
  promptPreview?: string;
  turns: CodexTurn[];
};

export type CodexSessionSummary = Omit<CodexSession, 'turns'>;

export type ArtifactMode = 'preview' | 'copy';

export type ToTurnContentOptions = {
  /** Agent identifier stored on the turn (defaults to 'codex'). */
  agent?: string;
  /** Provenance tag stored on metadata + the import marker artifact. */
  ingest?: string;
  /** Artifact key used for the dedup marker (defaults to 'codex.import'). */
  markerKey?: string;
};

export const CODEX_IMPORT_AGENT = 'codex';
export const IMPORT_ARTIFACT_KEY = 'codex.import';
const SMALL_TEXT_ARTIFACT_LIMIT = 16 * 1024;
const DEFAULT_INGEST = 'codex-import';
const SUMMARY_SCAN_MAX_LINES = 2_000;
const PROMPT_PREVIEW_LIMIT = 1_000;
const TIMESTAMP_TAIL_CHUNK_BYTES = 64 * 1024;

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

export async function readCodexSession(sourcePath: string, options: { artifactStore: string; artifactMode?: ArtifactMode }): Promise<CodexSession | null> {
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

export async function readCodexSessionSummary(sourcePath: string): Promise<CodexSessionSummary | null> {
  const fallbackUpdatedAt = (await stat(sourcePath)).mtime.toISOString();
  let sessionId = path.basename(sourcePath, '.jsonl');
  let cwd = os.homedir();
  let title: string | null = null;
  let promptPreview: string | null = null;
  let sawAssistant = false;
  let isSubagentSession = false;
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
    if (!entry) {
      continue;
    }

    if (entry.type === 'session_meta' && isRecord(entry.payload)) {
      sessionId = stringValue(entry.payload.id) ?? sessionId;
      cwd = stringValue(entry.payload.cwd) ?? cwd;
      isSubagentSession = isSubagentSession || entry.payload.thread_source === 'subagent';
      isSubagentSession = isSubagentSession || hasSubagentSource(entry.payload.source);
      continue;
    }

    if (entry.type !== 'response_item' || !isRecord(entry.payload) || entry.payload.type !== 'message') {
      continue;
    }
    if (entry.payload.role === 'user' && !title) {
      const prompt = summaryPromptFromText(textFromCodexContent(entry.payload.content));
      if (!prompt) {
        continue;
      }
      promptPreview = truncate(prompt, PROMPT_PREVIEW_LIMIT);
      title = titleFromPromptText(prompt, sessionId);
    } else if (entry.payload.role === 'assistant' && title) {
      sawAssistant = true;
      break;
    }
  }

  if (isSubagentSession || !title || !sawAssistant) {
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

export async function saveDataUrlArtifact(value: string, options: ArtifactWriteOptions): Promise<StoredArtifact>;
export async function saveDataUrlArtifact(value: string, artifactStore: string): Promise<StoredArtifact>;
export async function saveDataUrlArtifact(value: string, optionsOrStore: ArtifactWriteOptions | string): Promise<StoredArtifact> {
  const match = value.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/s);
  if (!match) {
    throw new Error('invalid data URL artifact');
  }
  const mimeType = match[1] || 'application/octet-stream';
  const payload = value.includes(';base64,')
    ? Buffer.from(match[2], 'base64')
    : Buffer.from(decodeURIComponent(match[2]), 'utf8');
  const options = typeof optionsOrStore === 'string' ? legacyArtifactWriteOptions(optionsOrStore) : optionsOrStore;
  return writeArtifactBytes(payload, {
    ...options,
    originalName: artifactNameFromValue(value, 'image'),
    extension: extensionForMimeType(mimeType),
    mimeType,
  });
}

function legacyArtifactWriteOptions(artifactStore: string): ArtifactWriteOptions {
  return {
    artifactStore,
    artifactMode: 'copy',
    sessionId: 'shared',
    agent: CODEX_IMPORT_AGENT,
    source: 'import',
    key: 'data-url',
    timestamp: new Date().toISOString(),
    baseDirs: [],
  };
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

export type StoredArtifact = {
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

export function toTurnContent(session: CodexSession, turn: CodexTurn, index: number, options: ToTurnContentOptions = {}): TurnContent {
  const markerKey = options.markerKey ?? IMPORT_ARTIFACT_KEY;
  const sourceTurnSequence = index;
  const metadata = {
    ingest: options.ingest ?? DEFAULT_INGEST,
    sourcePath: session.sourcePath,
    sourceSessionId: session.sessionId,
    sourceTurnSequence,
    importedAt: new Date().toISOString(),
  };
  return {
    sessionId: session.sessionId,
    project: session.project,
    cwd: session.cwd,
    agent: options.agent ?? CODEX_IMPORT_AGENT,
    metadata,
    createdAt: turn.promptTimestamp,
    updatedAt: turn.responseTimestamp,
    // No title on imported turns — leave it empty for the observer/extractor to own.
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

export function importMarker(session: CodexSession, turnIndex: number): string {
  return `${session.sessionId}#${turnIndex + 1}`;
}

export function markerFromTurn(turn: { response?: string | null; artifacts?: Array<{ key: string; content?: string }> | null }, markerKey: string = IMPORT_ARTIFACT_KEY): string | null {
  const artifact = turn.artifacts?.find((item) => item.key === markerKey);
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

// Slash-command turns wrap their text in <command-*> / <local-command-*> /
// <system-reminder> tags; strip those delimiters (keep inner text) for a
// readable display title. The stored prompt itself is left untouched.
const WRAPPER_TAGS = /<\/?(?:command-[a-z-]+|local-command-[a-z-]+|system-reminder)>/gi;

export function displayTitleFromPrompt(prompt: string): string {
  const cleaned = prompt.replace(WRAPPER_TAGS, '');
  const line = cleaned.split(/\n/).map((value) => value.trim()).find((value) => value.length > 0) ?? cleaned.trim();
  return truncate(line, 80);
}

function turnSummary(turn: CodexTurn): string {
  return truncate(`${turn.prompt.trim()}\n\n${turn.response.trim()}`, 1_000);
}

export type ProjectIdentity = {
  project: string;
};

const PROJECT_CACHE_VERSION = 2;
const projectIdentityCache = new Map<string, ProjectIdentity>();
const projectIdentityInflight = new Map<string, Promise<ProjectIdentity>>();

export async function resolveProjectIdentity(cwd: string): Promise<ProjectIdentity> {
  const fallback = await realpathOrResolved(cwd || os.homedir());
  const cachedIdentity = projectIdentityCache.get(fallback);
  if (cachedIdentity) {
    return cachedIdentity;
  }
  const inflight = projectIdentityInflight.get(fallback);
  if (inflight) {
    return inflight;
  }

  const promise = resolveProjectIdentityCached(fallback);
  projectIdentityInflight.set(fallback, promise);
  try {
    const identity = await promise;
    projectIdentityCache.set(fallback, identity);
    return identity;
  } finally {
    projectIdentityInflight.delete(fallback);
  }
}

async function resolveProjectIdentityCached(fallback: string): Promise<ProjectIdentity> {
  const cached = await readProjectCache(fallback);
  if (cached) {
    if (cached.project === fallback) {
      const recovered = await resolveDeletedCodexWorktreeProject(fallback);
      if (recovered) {
        const project = await resolveGithubProjectIdentity(recovered) ?? recovered;
        try {
          await writeProjectCache(fallback, project);
        } catch {
          // Cache writes are an optimization; import should continue if the
          // local cache path is temporarily unavailable.
        }
        return { project };
      }
    }
    return { project: cached.project };
  }

  const identity = await resolveProjectIdentityUncached(fallback);
  try {
    await writeProjectCache(fallback, identity.project);
  } catch {
    // Cache writes are an optimization; import should continue if the local
    // cache path is temporarily unavailable.
  }
  return identity;
}

async function resolveProjectIdentityUncached(cwd: string): Promise<ProjectIdentity> {
  try {
    const { stdout: topLevelStdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
    const topLevelRaw = topLevelStdout.trim();
    if (!topLevelRaw) {
      return { project: cwd };
    }
    const topLevel = await realpathOrResolved(topLevelRaw);

    const { stdout: commonDirStdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    const commonDirRaw = commonDirStdout.trim();
    if (!commonDirRaw) {
      return { project: await resolveGithubProjectIdentity(topLevel) ?? topLevel };
    }
    const commonDir = await realpathOrResolved(commonDirRaw);
    const canonical = commonDir.endsWith(`${path.sep}.git`) ? path.dirname(commonDir) : topLevel;
    return { project: await resolveGithubProjectIdentity(canonical) ?? canonical };
  } catch {
    const recovered = await resolveDeletedCodexWorktreeProject(cwd);
    if (recovered) {
      return { project: await resolveGithubProjectIdentity(recovered) ?? recovered };
    }
    return { project: cwd };
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
      // Missing remotes or non-git paths fall through to the next candidate.
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

async function resolveDeletedCodexWorktreeProject(cwd: string): Promise<string | null> {
  const home = path.resolve(os.homedir());
  const worktreesRoot = path.join(home, '.codex', 'worktrees');
  const relative = path.relative(worktreesRoot, cwd);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }

  const parts = relative.split(path.sep).filter(Boolean);
  const repoName = parts[1];
  if (!repoName) {
    return null;
  }

  const candidate = path.join(home, 'workspace', repoName);
  try {
    const { stdout } = await execFileAsync('git', ['-C', candidate, 'rev-parse', '--show-toplevel']);
    const topLevel = await realpathOrResolved(stdout.trim());
    const candidateRealpath = await realpathOrResolved(candidate);
    return topLevel === candidateRealpath ? candidateRealpath : null;
  } catch {
    return null;
  }
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
  const directTimestamp = stringValue(entry.timestamp);
  if (directTimestamp) {
    return directTimestamp;
  }
  const payload = isRecord(entry.payload) ? entry.payload : null;
  return stringValue(payload?.timestamp);
}

function textFromCodexContent(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) {
      continue;
    }
    const text = stringValue(part.text);
    if (text) {
      parts.push(text);
    }
  }
  const text = parts.join('\n\n').trim();
  return text.length > 0 ? text : null;
}

type ProjectCacheFile = {
  version: 2;
  projectsByCwd: Record<string, { project: string; resolvedAt: string }>;
};

function projectCachePath(): string {
  const home = process.env.MUNINN_HOME ?? path.join(os.homedir(), '.muninn');
  return path.join(home, 'project-cache.json');
}

async function readProjectCache(cwd: string): Promise<{ project: string; resolvedAt: string } | null> {
  try {
    const parsed = JSON.parse(await readFile(projectCachePath(), 'utf8')) as Partial<ProjectCacheFile>;
    if (parsed.version !== PROJECT_CACHE_VERSION) {
      return null;
    }
    const entry = parsed.projectsByCwd?.[cwd];
    return entry && typeof entry.project === 'string' ? entry : null;
  } catch {
    return null;
  }
}

async function writeProjectCache(cwd: string, project: string): Promise<void> {
  let cache: ProjectCacheFile = { version: PROJECT_CACHE_VERSION, projectsByCwd: {} };
  try {
    const parsed = JSON.parse(await readFile(projectCachePath(), 'utf8')) as Partial<ProjectCacheFile>;
    if (
      parsed
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && parsed.version === PROJECT_CACHE_VERSION
      && parsed.projectsByCwd
      && typeof parsed.projectsByCwd === 'object'
    ) {
      cache = { version: PROJECT_CACHE_VERSION, projectsByCwd: { ...parsed.projectsByCwd } };
    }
  } catch {
    // Create a new cache below.
  }
  cache.projectsByCwd[cwd] = { project, resolvedAt: new Date().toISOString() };
  await atomicWriteFile(projectCachePath(), `${JSON.stringify(cache, null, 2)}\n`);
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

export function defaultArtifactStore(): string {
  const home = process.env.MUNINN_HOME ?? path.join(os.homedir(), '.muninn');
  return path.join(home, 'default', 'artifacts');
}

// ---- Claude Code transcript parsing ----

export const CLAUDE_AGENT = 'claude-code';
export const CLAUDE_MARKER_KEY = 'claude-code.import';

export async function readClaudeSessionSummary(sourcePath: string): Promise<CodexSessionSummary | null> {
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

/**
 * Parse a Claude Code transcript (`~/.claude/projects/<cwd>/<sessionId>.jsonl`)
 * into the shared session shape. A new turn starts at each `type:'user'` line
 * whose `message.content` is a plain string (the real prompt); assistant text /
 * tool_use and the following user tool_result blocks belong to that turn.
 */
export async function readClaudeSession(
  sourcePath: string,
  options: { artifactStore: string; artifactMode?: ArtifactMode },
): Promise<CodexSession | null> {
  const content = await readFile(sourcePath, 'utf8');
  const fallbackUpdatedAt = (await stat(sourcePath)).mtime.toISOString();
  const artifactMode = options.artifactMode ?? 'copy';
  let sessionId = path.basename(sourcePath, '.jsonl');
  let cwd = os.homedir();
  let updatedAt = fallbackUpdatedAt;

  const sessionTurns: CodexTurn[] = [];
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
        // ignore unsavable image
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
