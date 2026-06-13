#!/usr/bin/env node
import { captureFromTranscript, isStopEvent, readStdin, type HookPayload } from '@muninn/common/agent-hook';
import { CLAUDE_AGENT, CLAUDE_MARKER_KEY, readClaudeSession, toTurnContent } from './claude.js';

const CLAUDE_HOOK_INGEST = 'claude-hook';

/**
 * Entry point registered as a Claude Code `Stop` hook command
 * (`~/.claude/settings.json`). Claude pipes the hook event as JSON on stdin
 * ({ session_id, transcript_path, cwd, hook_event_name }). On `Stop` we parse
 * the transcript and capture the latest turn. Always exits 0 so a hook failure
 * never blocks Claude Code.
 */
async function main(): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) {
    return;
  }
  let payload: HookPayload;
  try {
    payload = JSON.parse(raw) as HookPayload;
  } catch (error) {
    process.stderr.write(`[muninn-claude-hook] invalid hook JSON on stdin: ${String(error)}\n`);
    return;
  }
  if (!isStopEvent(payload)) {
    return;
  }
  const transcriptPath = (payload.transcript_path ?? '').trim();
  if (!transcriptPath) {
    return;
  }
  await captureFromTranscript({
    transcriptPath,
    readSession: readClaudeSession,
    toTurnContent,
    toTurnOptions: { agent: CLAUDE_AGENT, ingest: CLAUDE_HOOK_INGEST, markerKey: CLAUDE_MARKER_KEY },
    label: 'muninn-claude-hook',
  });
}

main()
  .catch((error) => {
    process.stderr.write(`[muninn-claude-hook] unexpected error: ${String(error)}\n`);
  })
  .finally(() => {
    process.exit(0);
  });
