#!/usr/bin/env node
import { handleStop, isStopEvent, type CodexHookPayload } from './hook.js';
import { createMuninnClient, resolveHookConfig } from '@muninn/common/agent-hook';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Entry point registered as a Codex lifecycle-hook `command`. Codex pipes the
 * hook event as JSON on stdin. We only act on `Stop` (turn end); every other
 * event is ignored. The process must always exit 0 so a hook failure never
 * blocks Codex.
 */
async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const raw = await readStdin();
  if (!raw.trim()) {
    return;
  }

  let payload: CodexHookPayload;
  try {
    payload = JSON.parse(raw) as CodexHookPayload;
  } catch (error) {
    process.stderr.write(`[muninn-codex-hook] invalid hook JSON on stdin: ${String(error)}\n`);
    return;
  }

  if (!isStopEvent(payload)) {
    return;
  }

  const serverUrl = await resolveServerUrl(options, payload);

  await handleStop(payload, serverUrl
    ? {
        client: createMuninnClient({
          config: {
            ...resolveHookConfig(),
            baseUrl: serverUrl.replace(/\/+$/, ''),
          },
          label: 'muninn-codex-hook',
        }),
      }
    : {});
}

function parseCliOptions(argv: string[]): { serverUrl?: string } {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--server-url') {
      const value = argv[index + 1]?.trim();
      if (value) {
        return { serverUrl: value };
      }
      continue;
    }
    if (arg.startsWith('--server-url=')) {
      const value = arg.slice('--server-url='.length).trim();
      if (value) {
        return { serverUrl: value };
      }
    }
  }
  return {};
}

async function resolveServerUrl(options: { serverUrl?: string }, payload: CodexHookPayload): Promise<string | undefined> {
  if (options.serverUrl) {
    return options.serverUrl;
  }
  const fromConfig = await readHookServerUrl(payload);
  return fromConfig ?? undefined;
}

async function readHookServerUrl(payload: CodexHookPayload): Promise<string | null> {
  for (const configPath of candidateHookConfigPaths(payload)) {
    try {
      const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const serverUrl = (parsed as { serverUrl?: unknown }).serverUrl;
        if (typeof serverUrl === 'string' && serverUrl.trim()) {
          return serverUrl.trim();
        }
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function candidateHookConfigPaths(payload: CodexHookPayload): string[] {
  const candidates: string[] = [];
  const explicit = process.env.MUNINN_CODEX_HOOK_CONFIG?.trim();
  if (explicit) {
    candidates.push(explicit);
  }
  for (const root of [payload.cwd, process.cwd()]) {
    if (typeof root === 'string' && root.trim()) {
      candidates.push(...ancestorHookConfigs(root.trim()));
    }
  }
  candidates.push(path.join(os.homedir(), '.codex', 'muninn-hook.json'));
  return [...new Set(candidates)];
}

function ancestorHookConfigs(start: string): string[] {
  const configs: string[] = [];
  let current = path.resolve(start);
  for (;;) {
    configs.push(path.join(current, '.codex', 'muninn-hook.json'));
    const parent = path.dirname(current);
    if (parent === current) {
      return configs;
    }
    current = parent;
  }
}

function readStdin(): Promise<string> {
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

main()
  .catch((error) => {
    process.stderr.write(`[muninn-codex-hook] unexpected error: ${String(error)}\n`);
  })
  .finally(() => {
    process.exit(0);
  });
