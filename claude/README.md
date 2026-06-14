# @muninn/claude

Claude Code integration for Muninn.

This package owns Claude transcript parsing and the `muninn-claude-hook` bin.
It does not depend on `@muninn/codex`; shared hook capture/cache code lives in
`@muninn/common/agent-hook`.

## Build

```sh
pnpm --filter @muninn/claude build
```

## Register the hook

Add the built hook to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "node /ABSOLUTE/PATH/TO/muninn/claude/dist/claude-cli.js" } ] }
    ]
  }
}
```

Claude pipes `{ session_id, transcript_path, cwd, hook_event_name }` on stdin.
On `Stop`, the hook parses the transcript and captures the latest turn as
`agent: claude-code`.

## E2E test command

Run the CI-safe E2E with a mock Claude Code client and the real Muninn hook:

```sh
pnpm --filter @muninn/claude test:e2e
```

The mock client creates Claude transcript fixtures and invokes the built
`muninn-claude-hook` through a real Stop payload. It verifies baseline import,
hook capture, session deletion, project deletion, and that capture stops after
the project policy is removed.

Run host mode manually:

```sh
pnpm --filter @muninn/claude test:e2e:host
```

Host mode currently skips because real Claude Code automation is not part of the
default local test path.
