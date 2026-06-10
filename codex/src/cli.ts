#!/usr/bin/env node
import { handleStop, isStopEvent, type CodexHookPayload } from './hook.js';

/**
 * Entry point registered as a Codex lifecycle-hook `command`. Codex pipes the
 * hook event as JSON on stdin. We only act on `Stop` (turn end); every other
 * event is ignored. The process must always exit 0 so a hook failure never
 * blocks Codex.
 */
async function main(): Promise<void> {
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

  await handleStop(payload);
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
