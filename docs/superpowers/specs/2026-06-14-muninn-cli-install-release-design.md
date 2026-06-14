# Muninn CLI Install and Release Design

## Summary

Muninn should ship its first installable release as a macOS and Linux npm CLI. The CLI gives users one visible entrypoint:

```sh
npm i -g @muninn/cli
muninn doctor
muninn serve
muninn install all
```

The first release keeps the server in the foreground, installs Codex and Claude Code integrations only after user confirmation, and uses local native compilation for the Rust-backed server addon. A later macOS app can reuse the same installer core while providing a friendlier desktop startup path.

## Goals

- Publish a working npm-based install path for macOS and Linux.
- Provide a single user-facing `muninn` CLI.
- Start Muninn with a visible foreground `muninn serve` command.
- Install Muninn into Codex and Claude Code by configuring their MCP server and Stop hook entries.
- Support interactive confirmation, `--dry-run`, `--yes`, and file backups for config writes.
- Keep `mcp/` as a protocol adapter package, not as an install target.
- Require local native compilation for the first release, with clear diagnostics.
- Leave the macOS app as a second-stage host that reuses the installer logic.

## Non-Goals

- Do not support Windows in the first release.
- Do not add a background service, launchd unit, systemd unit, login item, or daemon command.
- Do not add background or automatic updates.
- Do not add prebuilt native binaries in the first release.
- Do not make `mcp` an independent `muninn install` target.
- Do not preserve compatibility with historical `packages/*` paths.
- Do not silently modify Codex or Claude Code configuration.

## Target Package Shape

Add a top-level `cli/` package:

```text
cli/
  package: @muninn/cli
  bin: muninn
```

The publishable workspace packages are:

```text
@muninn/common
@muninn/server
@muninn/mcp
@muninn/codex
@muninn/claude
@muninn/cli
```

The root package remains private and only coordinates the workspace. The publishable packages should remove `private: true` and define complete publish metadata:

- `files`
- `bin`
- `exports`
- `types` where relevant
- `engines`
- README
- license metadata

`@muninn/cli` depends on the runtime packages:

```text
@muninn/cli
  -> @muninn/server
  -> @muninn/mcp
  -> @muninn/codex
  -> @muninn/claude
```

The first release should not bundle all packages into one generated JavaScript file. Keeping package boundaries intact makes the native addon, prompt files, web assets, and package bins easier to publish and diagnose.

## CLI Commands

The first CLI command set is:

```sh
muninn doctor
muninn serve
muninn install codex
muninn install claude
muninn install all
muninn uninstall codex
muninn uninstall claude
muninn uninstall all
muninn status
```

`install` targets hosts, not protocols. `@muninn/mcp` is the stdio MCP adapter that the host configurations point at.

### `muninn doctor`

Checks local prerequisites and prints actionable diagnostics:

- Node.js version.
- `cargo` availability.
- `protoc` availability.
- Platform support: macOS or Linux.
- Server native addon can be built or loaded.
- `muninn-mcp`, `muninn-codex-hook`, and `muninn-claude-hook` can resolve to runnable commands or absolute paths.
- Codex and Claude Code config locations are discoverable or creatable.
- `http://127.0.0.1:8080/health` if a server is running.

### `muninn serve`

Starts `@muninn/server` in the foreground:

```sh
muninn serve
muninn serve --host 127.0.0.1 --port 8080 --home ~/.muninn
```

Defaults:

```text
HOST=127.0.0.1
PORT=8080
MUNINN_HOME=~/.muninn
```

The command does not fork, daemonize, auto-restart, or install any system service. It should print the server URL, data home, and health URL after startup.

If the port is occupied, the CLI should explain the conflict and suggest:

```sh
muninn serve --port 8081
muninn install all --server-url http://127.0.0.1:8081
```

The server URL is stable configuration. The first release should not pick random ports because Codex and Claude Code MCP/hook configuration needs a durable endpoint.

### `muninn install`

Installs Muninn into a host:

```sh
muninn install codex
muninn install claude
muninn install all
```

Options:

```sh
--mcp-only
--hook-only
--scope user|project
--server-url http://127.0.0.1:8080
--dry-run
--yes
```

Default behavior is interactive confirmation. Before writing, the command shows the planned changes as a diff or equivalent summary. Every actual write creates a timestamped backup of the target file.

### `muninn uninstall`

Removes only Muninn-managed entries:

```sh
muninn uninstall codex
muninn uninstall claude
muninn uninstall all
```

It must preserve unrelated user MCP servers, hooks, comments where possible, and settings. It also backs up files before writing.

### `muninn status`

Reports:

- Whether the server is online.
- Which server URL the installation points at.
- Whether Codex MCP is installed.
- Whether Codex Stop hook is installed.
- Whether Claude Code MCP is installed.
- Whether Claude Code Stop hook is installed.

## Codex Integration

`muninn install codex` writes to user `~/.codex/config.toml` or project `.codex/config.toml`, depending on `--scope`.

The MCP entry is:

```toml
[mcp_servers.muninn]
command = "muninn-mcp"
env = { MUNINN_SERVER_BASE_URL = "http://127.0.0.1:8080" }
```

The Stop hook entry is:

```toml
[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "muninn-codex-hook"
timeout = 30
statusMessage = "Syncing turn to Muninn"
```

If `muninn-mcp` or `muninn-codex-hook` cannot be trusted to resolve from the host process `PATH`, the installer should write an absolute path to the resolved bin. This avoids failures when Codex is launched from an app, IDE, shell, or environment with a different `PATH`.

The installer must be idempotent:

- Existing `[mcp_servers.muninn]` is updated, not duplicated.
- Existing Muninn Stop hook is updated, not duplicated.
- Other MCP servers and hooks remain unchanged.
- `uninstall codex` deletes only Muninn MCP and Muninn Stop hook entries.

Codex supports stdio MCP servers via `mcp_servers.<name>` with `command`, optional `args`, and `env`. Codex lifecycle hooks support command handlers under `hooks.Stop`, with `timeout` measured in seconds and optional `statusMessage`.

## Claude Code Integration

`muninn install claude` configures both MCP and a Stop hook.

For MCP, prefer the Claude CLI when available:

```sh
claude mcp add --scope user --transport stdio muninn \
  --env MUNINN_SERVER_BASE_URL=http://127.0.0.1:8080 \
  -- muninn-mcp
```

For project scope, use the corresponding Claude project MCP configuration path or the `claude mcp add` scope that writes project `.mcp.json`. In dry-run mode, show the equivalent JSON/config action instead of mutating through the Claude CLI.

The Stop hook writes to `~/.claude/settings.json` or project `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "muninn-claude-hook",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

As with Codex, write an absolute hook or MCP command path if the host process may not resolve npm global bins from `PATH`.

The installer must be idempotent:

- Existing Muninn MCP server is updated, not duplicated.
- Existing Muninn Stop hook is updated, not duplicated.
- Other Claude Code hooks and MCP servers remain unchanged.
- `uninstall claude` deletes only Muninn entries.

Claude Code supports local stdio MCP servers and Stop hooks. Stop hooks receive transcript path and session metadata, which matches the existing `muninn-claude-hook` input model.

## Managed Config Identification

MCP entries are managed by server name:

```text
muninn
```

Hook entries are managed when their command is one of:

```text
muninn-codex-hook
muninn-claude-hook
```

or when the command resolves to the current installed Muninn bin path.

The installer should not depend on TOML or JSON comments as the primary marker because comments may be lost or reformatted by parsers. Comments can be preserved when feasible but are not part of correctness.

## Server Runtime Contract

Hooks and MCP connect to the server through:

```text
MUNINN_SERVER_BASE_URL
```

Default:

```text
http://127.0.0.1:8080
```

Codex and Claude Code hook failures must remain fail-soft. A stopped or missing server must not block Codex or Claude Code turns.

MCP tools may surface connection errors when the server is offline. The CLI should make this easy to diagnose through:

```sh
muninn status
muninn doctor
```

First-release data home:

```text
~/.muninn
```

The future macOS app can default to:

```text
~/Library/Application Support/Muninn
```

The CLI and app may share a data directory only when explicitly configured. The first release should not attempt automatic migration between these homes.

## Native Build and Publish Requirements

The first release builds the server native addon locally during package installation or first build.

Required user dependencies:

- Node.js 20 or newer.
- Rust toolchain with `cargo`.
- `protoc`.
- macOS: Xcode Command Line Tools.
- Linux: standard native build tools such as a compiler, linker, and make.

`@muninn/server` must be publish-safe:

- Its native build script cannot assume a monorepo checkout.
- It cannot require `pnpm --filter` at runtime.
- Native output paths must be stable inside the published package.
- Published files must include runtime assets:

```text
dist/
native/
prompts/
scripts/build-native.mjs
package.json
README.md
```

`muninn doctor` must distinguish:

- Missing `cargo`.
- Missing `protoc`.
- Native addon not built.
- Native addon load failure.
- Unsupported platform.
- Node version mismatch.

Prebuilt native binaries are a second-stage release item:

- Build macOS arm64/x64 and Linux x64/arm64 in CI.
- Prefer prebuilds during install.
- Fall back to local compilation.

## Background Service Exclusion

The first release does not include:

```sh
muninn service install
muninn service start
muninn service stop
muninn service uninstall
```

It does not write macOS launchd plists, Linux systemd user units, login items, cron jobs, or shell startup entries.

Rationale:

- macOS and Linux service behavior differs.
- Services need log paths, restart policy, uninstall behavior, and environment handling.
- npm global upgrades can leave services pointing at stale paths.
- Provider keys, `MUNINN_HOME`, and `PATH` are harder to reason about in background environments.
- Foreground startup gives a simpler MVP and better diagnostics.

A later service design can add:

```sh
muninn service install --user
muninn service start
muninn service logs
muninn service uninstall
```

## Background Update Exclusion

The first release does not include:

- Scheduled update checks.
- Automatic npm package updates.
- Silent binary replacement.
- Silent hook or MCP config rewrites.
- App-style updater behavior.

Users upgrade through npm:

```sh
npm update -g @muninn/cli
npm i -g @muninn/cli@latest
```

Rationale:

- npm global packages should not silently replace themselves.
- Native addon rebuilds during automatic update are fragile.
- Running server replacement requires a separate lifecycle design.
- This repository does not target forward compatibility during MVP iteration.
- Codex and Claude Code configuration should only change after explicit user action.

## Testing

Unit tests:

- CLI argument parsing.
- Codex TOML read/write.
- Codex install into empty config.
- Codex install with existing unrelated MCP servers.
- Codex install with existing unrelated hooks.
- Codex repeated install is idempotent.
- Codex uninstall removes only Muninn entries.
- Claude JSON and `.mcp.json` read/write.
- Claude install into empty config.
- Claude install with existing unrelated MCP servers.
- Claude install with existing unrelated hooks.
- Claude repeated install is idempotent.
- Claude uninstall removes only Muninn entries.
- Bin path resolution chooses command name when safe and absolute path when needed.

Integration tests:

- `muninn doctor` reports missing dependencies clearly.
- `muninn serve` starts the server and `/health` returns success.
- `muninn install codex --dry-run` prints the expected TOML changes.
- `muninn install claude --dry-run` prints the expected Claude actions.
- `muninn install all --yes` writes expected config under a temporary HOME.
- `muninn status` reports server online and offline states.

Manual release validation:

1. On a clean macOS environment:

   ```sh
   npm i -g @muninn/cli
   muninn doctor
   muninn serve
   muninn install all
   ```

2. Codex shows the Muninn MCP server through its MCP status UI.
3. Claude Code shows the Muninn MCP server through `/mcp`.
4. A completed Codex turn runs the Stop hook without blocking and captures into Muninn.
5. A completed Claude Code turn runs the Stop hook without blocking and captures into Muninn.
6. `muninn uninstall all` removes only Muninn entries.
7. Linux repeats CLI install, server health, and dry-run/install config tests.

## Documentation Requirements

The release README should lead with:

```sh
npm i -g @muninn/cli
muninn doctor
muninn serve
muninn install all
```

It must state:

- macOS and Linux are supported in the first release.
- Windows is not supported in the first release.
- `muninn serve` must be running for hooks and MCP recall to work.
- Hooks fail soft when the server is unavailable.
- The first release does not install a background service.
- The first release does not perform background updates.
- Rust, `cargo`, `protoc`, and platform build tools are required.
- `@muninn/mcp` is a protocol adapter and is installed into Codex/Claude Code through host-specific install commands, not through `muninn install mcp`.

## Rollout Order

1. Make runtime packages publish-safe.
2. Add `@muninn/cli` with `doctor`, `serve`, and status plumbing.
3. Add Codex config planner, dry-run, write, backup, and uninstall.
4. Add Claude Code config planner, dry-run, write, backup, and uninstall.
5. Add install/status tests under temporary HOME fixtures.
6. Add publish documentation.
7. Validate macOS and Linux install paths.

