#!/usr/bin/env node
import { handleStop, isStopEvent, type CodexHookPayload } from './hook.js';
import { createMuninnClient, resolveHookConfig, writeHookDebugEvent } from '@muninn/common/agent-hook';
import os from 'node:os';

/**
 * Entry point registered as a Codex lifecycle-hook `command`. Codex pipes the
 * hook event as JSON on stdin. We only act on `Stop` (turn end); every other
 * event is ignored. The process must always exit 0 so a hook failure never
 * blocks Codex.
 */
async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const raw = await readStdin();
  await writeHookDebugEvent('muninn-codex-hook', {
    stage: 'stdin-read',
    rawBytes: Buffer.byteLength(raw),
    rawTrimmedBytes: Buffer.byteLength(raw.trim()),
    argv: process.argv.slice(2),
    processCwd: process.cwd(),
    home: os.homedir(),
    env: {
      HOME: process.env.HOME,
      MUNINN_HOME: process.env.MUNINN_HOME,
      NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY,
    },
    nodeVersion: process.version,
  });
  if (!raw.trim()) {
    await writeHookDebugEvent('muninn-codex-hook', { stage: 'skip-empty-stdin' });
    return;
  }

  let payload: CodexHookPayload;
  try {
    payload = JSON.parse(raw) as CodexHookPayload;
  } catch (error) {
    await writeHookDebugEvent('muninn-codex-hook', {
      stage: 'skip-invalid-json',
      error: String(error),
    });
    process.stderr.write(`[muninn-codex-hook] invalid hook JSON on stdin: ${String(error)}\n`);
    return;
  }

  await writeHookDebugEvent('muninn-codex-hook', {
    stage: 'payload-read',
    hookEventName: payload.hook_event_name,
    isStop: isStopEvent(payload),
    sessionId: payload.session_id,
    transcriptPath: payload.transcript_path,
    agentTranscriptPath: payload.agent_transcript_path,
    cwd: payload.cwd,
    turnId: payload.turn_id,
  });
  if (!isStopEvent(payload)) {
    await writeHookDebugEvent('muninn-codex-hook', {
      stage: 'skip-non-stop',
      hookEventName: payload.hook_event_name,
    });
    return;
  }

  const serverUrl = resolveServerUrl(options);
  await writeHookDebugEvent('muninn-codex-hook', {
    stage: 'server-url-resolved',
    serverUrl,
    hasServerUrl: Boolean(serverUrl),
  });

  const captured = await handleStop(payload, serverUrl
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
  await writeHookDebugEvent('muninn-codex-hook', {
    stage: 'handle-stop-finished',
    captured,
  });
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

function resolveServerUrl(options: { serverUrl?: string }): string | undefined {
  return options.serverUrl;
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
  .catch(async (error) => {
    await writeHookDebugEvent('muninn-codex-hook', {
      stage: 'unexpected-error',
      error: String(error),
    });
    process.stderr.write(`[muninn-codex-hook] unexpected error: ${String(error)}\n`);
  })
  .finally(() => {
    process.exit(0);
  });
