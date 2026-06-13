# @muninn/codex

Codex CLI/app integration for Muninn.

This package does two things:

1. **Shared mapping** (`./` export) — parses Codex session transcripts
   (`~/.codex/sessions/**/rollout-*.jsonl`) into Muninn's `TurnContent`. This is
   the single source of truth for Codex → Muninn field mapping, reused by the
   web/import flows and the hook CLI below.
2. **Stop hook CLI** (`muninn-codex-hook` bin) — a runnable command you register
   on Codex's `Stop` lifecycle hook. At the end of every turn it re-parses the
   session transcript and POSTs the latest turn to the running Muninn sidecar.

## How it works

Codex 0.138.0 ships lifecycle hooks. On `Stop` (turn end)
Codex invokes the registered command with the hook event as JSON on **stdin**:

```json
{
  "hook_event_name": "Stop",
  "session_id": "019e...-codex-session",
  "transcript_path": "/Users/you/.codex/sessions/2026/06/10/rollout-...-019e....jsonl",
  "cwd": "/Users/you/workspace/project",
  "turn_id": "...",
  "last_assistant_message": "...",
  "stop_hook_active": false
}
```

The CLI reads `transcript_path`, parses the just-completed turn with the shared
mapping, and `POST`s it to `${MUNINN_SIDECAR_URL}/api/v1/turn/capture`. It is
**fail-soft**: any error is logged to stderr and the process always exits `0`,
so a hook failure never blocks Codex.

## Build

```sh
pnpm --filter @muninn/codex build
```

This produces `dist/cli.js` (the `muninn-codex-hook` bin).

## Register the hook

Make sure the Muninn sidecar is running (default `http://localhost:8080`), then
add the hook to `~/.codex/config.toml` (or a project-level `.codex/config.toml`):

```toml
[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "/ABSOLUTE/PATH/TO/muninn/codex/dist/cli.js"
timeout = 30
statusMessage = "Syncing turn to Muninn"
```

Point `command` at the built `dist/cli.js` (it has a `#!/usr/bin/env node`
shebang and is executable), or at the `muninn-codex-hook` bin if this package is
installed on `PATH`.

If the sidecar is not on the default port, set the endpoint via env. Codex
hooks inherit the environment of the Codex process, so export it before
launching Codex:

```sh
export MUNINN_SIDECAR_URL="http://localhost:8080"   # default
export MUNINN_HOOK_TIMEOUT_MS=1500                  # optional, default 1500
```

> Codex requires hooks to be trusted. The first time a hook source is seen it
> must be approved (or run Codex with `--dangerously-bypass-hook-trust` for
> automation that already vets the source). Note that `hooks.json` is **not**
> auto-discovered and hooks cannot be injected via `-c` overrides — they must
> live in `config.toml` (or a `config.toml`-referenced hooks file).

## Verify end-to-end

1. Build this package and start the sidecar.
2. Register the `Stop` hook as above.
3. Run a Codex turn (in the Codex app/TUI; lifecycle hooks fire there, not under
   `codex exec`).
4. Confirm the turn appears in Muninn (board UI, or query the sidecar).

You can also exercise the capture path directly without Codex:

```sh
echo '{"hook_event_name":"Stop","transcript_path":"/path/to/rollout-....jsonl"}' \
  | MUNINN_SIDECAR_URL=http://localhost:8080 node dist/cli.js
```

## Scope / roadmap

- **Now:** `Stop` → capture. The transcript already contains the full turn
  (prompt, response, tool calls, artifacts), so a single `Stop` hook captures
  every field with no loss.
- **Deferred:** recall injection on `UserPromptSubmit`. Codex supports returning
  `hookSpecificOutput.additionalContext` from that hook, which would let Muninn
  inject relevant memories into the prompt (parity with the OpenClaw plugin's
  two-way integration).
