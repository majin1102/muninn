import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const PROJECT_ID = 'github.com/muninn/e2e-fixture';

export async function writeMuninnConfig(home) {
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, 'muninn.json'), JSON.stringify({
    extractor: {
      name: 'default',
      llmProvider: 'mock',
      embeddingProvider: 'mock',
    },
    observer: {
      name: 'default',
      llmProvider: 'mock',
    },
    providers: {
      llm: {
        mock: {
          type: 'mock',
        },
      },
      embedding: {
        mock: {
          type: 'mock',
          dimensions: 4,
        },
      },
    },
  }, null, 2));
}

export async function createWorkspace(agent) {
  const root = await mkdtemp(path.join(os.tmpdir(), `muninn-${agent}-e2e-`));
  const home = path.join(root, 'home');
  const muninnHome = path.join(root, 'muninn-home');
  const project = path.join(root, 'project');
  await mkdir(home, { recursive: true });
  await mkdir(muninnHome, { recursive: true });
  await mkdir(project, { recursive: true });
  await execFileAsync('git', ['-C', project, 'init']);
  await execFileAsync('git', ['-C', project, 'config', 'user.email', 'e2e@example.com']);
  await execFileAsync('git', ['-C', project, 'config', 'user.name', 'Muninn E2E']);
  await execFileAsync('git', ['-C', project, 'remote', 'add', 'origin', 'https://github.com/muninn/e2e-fixture.git']);
  return { root, home, muninnHome, project };
}

export function codexLines(sessionId, cwd, turns) {
  const lines = [
    { type: 'session_meta', payload: { id: sessionId, cwd, timestamp: '2026-06-14T10:00:00.000Z' } },
  ];
  for (const [index, turn] of turns.entries()) {
    const minute = String(index).padStart(2, '0');
    lines.push(
      { type: 'response_item', timestamp: `2026-06-14T10:${minute}:01.000Z`, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: turn.prompt }] } },
      { type: 'response_item', timestamp: `2026-06-14T10:${minute}:02.000Z`, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: turn.response }] } },
    );
  }
  return lines;
}

export async function writeCodexTranscript(home, sessionId, cwd, turns) {
  const dir = path.join(home, '.codex', 'sessions', '2026', '06', '14');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-06-14-${sessionId}.jsonl`);
  await writeFile(file, codexLines(sessionId, cwd, turns).map((line) => JSON.stringify(line)).join('\n'));
  return file;
}

export function claudeLines(sessionId, cwd, turns) {
  const lines = [];
  for (const [index, turn] of turns.entries()) {
    const minute = String(index).padStart(2, '0');
    lines.push(
      { type: 'user', sessionId, cwd, timestamp: `2026-06-14T11:${minute}:01.000Z`, message: { role: 'user', content: turn.prompt } },
      { type: 'assistant', sessionId, cwd, timestamp: `2026-06-14T11:${minute}:02.000Z`, message: { role: 'assistant', content: [{ type: 'text', text: turn.response }] } },
    );
  }
  return lines;
}

export async function writeClaudeTranscript(home, sessionId, cwd, turns) {
  const dir = path.join(home, '.claude', 'projects', 'muninn-e2e-fixture');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  await writeFile(file, claudeLines(sessionId, cwd, turns).map((line) => JSON.stringify(line)).join('\n'));
  return file;
}

export function stopPayload(sessionId, transcriptPath, cwd) {
  return {
    hook_event_name: 'Stop',
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
  };
}
