import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveDataUrlArtifact, type ArtifactMode, type CodexSession, type CodexTurn } from '@muninn/codex';
import type { Artifact, TurnEvent } from '@muninn/types';
import type { ImportAdapter } from './import_core.js';

export const CLAUDE_IMPORT_AGENT = 'claude-code';
export const CLAUDE_MARKER_KEY = 'claude-code.import';
export const CLAUDE_INGEST = 'claude-code-import';

function claudeProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/** Adapter consumed by import_core for the generic list/import flow. */
export const claudeAdapter: ImportAdapter = {
  agent: CLAUDE_IMPORT_AGENT,
  markerKey: CLAUDE_MARKER_KEY,
  ingest: CLAUDE_INGEST,
  sourceRoot: path.join(os.homedir(), '.claude', 'projects'),
  listSessionFiles: () => listClaudeSessionFiles(claudeProjectsRoot()),
  readSession: (sourcePath, options) => readClaudeSession(sourcePath, options),
};

async function listClaudeSessionFiles(root: string): Promise<string[]> {
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
      files.push(...await listClaudeSessionFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(entryPath);
    }
  }
  return files;
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

  const turns: CodexTurn[] = [];
  let promptParts: string[] = [];
  let promptTimestamp: string | null = null;
  let responseParts: string[] = [];
  let responseTimestamp: string | null = null;
  let events: TurnEvent[] = [];
  let artifacts: Artifact[] = [];
  let artifactSeq = 0;

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
    turns.push({
      prompt,
      response,
      promptTimestamp: promptTimestamp ?? responseTimestamp ?? updatedAt,
      responseTimestamp: responseTimestamp ?? promptTimestamp ?? updatedAt,
      events: events.map((event) => ({ ...event })),
      artifacts: [...artifacts],
    });
    resetTurn();
  };
  const resetTurn = () => {
    promptParts = [];
    promptTimestamp = null;
    responseParts = [];
    responseTimestamp = null;
    events = [];
    artifacts = [];
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

  if (turns.length === 0) {
    return null;
  }

  const firstLine = turns[0]?.prompt.split(/\n/).find((value) => value.trim().length > 0)?.trim();
  return {
    sessionId,
    cwd,
    projectKey: path.basename(cwd) || 'claude-code',
    sourcePath,
    updatedAt,
    title: firstLine ? firstLine.slice(0, 48) : sessionId.slice(0, 12),
    turns,
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
