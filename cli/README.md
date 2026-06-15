# @muninn/cli

Muninn CLI installs and runs Muninn for local agent memory.

## Install

```sh
npm i -g @muninn/cli
muninn doctor
muninn run
muninn install all
```

The first release supports macOS and Linux. Windows is not supported.

`muninn run` runs the server in the foreground. `muninn start` starts a CLI-managed background process and returns; `muninn stop` stops that process; `muninn restart --force` force-restarts it. Keep Muninn running while using Codex or Claude Code MCP tools and Stop hooks.

## Commands

```sh
muninn doctor
muninn run
muninn start
muninn stop
muninn restart --force
muninn install codex
muninn install claude
muninn install all
muninn uninstall codex
muninn uninstall claude
muninn uninstall all
muninn status
```

Muninn does not install a system background service or background updater in the first release.

## Native Requirements

`@muninn/server` builds a native addon locally. Install Node.js 20+, Rust with `cargo`, `protoc`, and platform build tools before installing.
