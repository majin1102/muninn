# @muninn/codex

Codex CLI/app integration for Muninn.

This package does two things:

1. **Shared mapping** (`./` export) — parses Codex session transcripts
   (`~/.codex/sessions/**/rollout-*.jsonl`) into Muninn's `TurnContent`. This is
   the single source of truth for Codex → Muninn field mapping, reused by the
   web/import flows and the hook CLI below.
2. **Stop hook CLI** (`muninn-codex-hook` bin) — a runnable command you register
   on Codex's `Stop` lifecycle hook. At the end of every turn it re-parses the
   session transcript and POSTs the latest turn to the running Muninn server.

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
mapping, and `POST`s it to `${MUNINN_SERVER_BASE_URL}/api/v1/turn/capture`. It is
**fail-soft**: any error is logged to stderr and the process always exits `0`,
so a hook failure never blocks Codex.

## Build

```sh
pnpm --filter @muninn/codex build
```

This produces `dist/cli.js` (the `muninn-codex-hook` bin).

## Register the hook

Make sure the Muninn server is running (default `http://localhost:8080`), then
add the hook to `~/.codex/config.toml` (or a project-level `.codex/config.toml`):

```toml
[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "/ABSOLUTE/PATH/TO/muninn/codex/dist/cli.js"
timeout = 5
statusMessage = "Capturing conversation by muninn"
```

Point `command` at the built `dist/cli.js` (it has a `#!/usr/bin/env node`
shebang and is executable), or at the `muninn-codex-hook` bin if this package is
installed on `PATH`.

If the server is not on the default port, pass the endpoint in the hook command:

```json
// ~/.codex/muninn-hook.json, or .codex/muninn-hook.json for project scope
{
  "serverUrl": "http://127.0.0.1:52423"
}
```

The hook still supports environment variables for manual runs or custom launch
wrappers:

```sh
export MUNINN_SERVER_BASE_URL="http://localhost:8080"   # default
export MUNINN_HOOK_TIMEOUT_MS=1500                  # optional, default 1500
```

> Codex requires hooks to be trusted. The first time a hook source is seen it
> must be approved (or run Codex with `--dangerously-bypass-hook-trust` for
> automation that already vets the source). Note that `hooks.json` is **not**
> auto-discovered and hooks cannot be injected via `-c` overrides — they must
> live in `config.toml` (or a `config.toml`-referenced hooks file).

## Verify end-to-end

1. Build this package and start the server.
2. Register the `Stop` hook as above.
3. Run a Codex turn (in the Codex app/TUI; lifecycle hooks fire there, not under
   `codex exec`).
4. Confirm the turn appears in Muninn (app UI, or query the server).

You can also exercise the capture path directly without Codex:

```sh
echo '{"hook_event_name":"Stop","transcript_path":"/path/to/rollout-....jsonl"}' \
  | MUNINN_SERVER_BASE_URL=http://localhost:8080 node dist/cli.js
```

## E2E test command

Run the CI-safe E2E with a mock Codex client and the real Muninn hook:

```sh
pnpm --filter @muninn/codex test:e2e
```

The mock client creates Codex transcript fixtures and invokes the built
`muninn-codex-hook` through a real Stop payload. It verifies baseline import,
hook capture, session deletion, project deletion, and that capture stops after
the project policy is removed.

Run host mode manually:

```sh
pnpm --filter @muninn/codex test:e2e:host
```

Host mode is opt-in and may skip when the available Codex invocation path cannot
trigger lifecycle hooks non-interactively.

## Scope / roadmap

- **Now:** `Stop` → capture. The transcript already contains the full turn
  (prompt, response, tool calls, artifacts), so a single `Stop` hook captures
  every field with no loss.
- **Deferred:** recall injection on `UserPromptSubmit`. Codex supports returning
  `hookSpecificOutput.additionalContext` from that hook, which would let Muninn
  inject relevant memories into the prompt (parity with the OpenClaw plugin's
  two-way integration).
