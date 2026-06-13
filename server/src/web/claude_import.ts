import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_AGENT, CLAUDE_MARKER_KEY, readClaudeSession, readClaudeSessionSummary } from '@muninn/claude';
import type { ImportAdapter } from './import_core.js';

export const CLAUDE_IMPORT_AGENT = CLAUDE_AGENT;
export const CLAUDE_INGEST = 'claude-code-import';

function claudeProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/** Adapter consumed by import_core for the generic list/import flow. */
export const claudeAdapter: ImportAdapter = {
  agent: CLAUDE_AGENT,
  markerKey: CLAUDE_MARKER_KEY,
  ingest: CLAUDE_INGEST,
  sourceRoot: claudeProjectsRoot(),
  listSessionFiles: () => listClaudeSessionFiles(claudeProjectsRoot()),
  readSessionSummary: (sourcePath) => readClaudeSessionSummary(sourcePath),
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
