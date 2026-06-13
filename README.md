# Muninn

Muninn is a memory layer for agents. This repository contains the Rust `format/` subsystem, the TypeScript product/runtime packages, the OpenClaw plugin, and the project documentation.

## Repository Layout

- `format/`
  - Rust typed-table, format, and storage implementation.
- `server/`
  - TypeScript HTTP runtime and memory implementation, including the Node native binding.
- `web/`, `mcp/`, `codex/`, `claude/`, `common/`
  - Product UI, protocol adapters, agent integrations, and shared contracts/helpers.
- `openclaw/`
  - OpenClaw integration and plugin code.
- `docs/`
  - Product notes, specs, architecture documents, comparisons, research notes, and workstream trackers.

## First Installable Release Direction

The first installable release is planned as a macOS/Linux npm CLI:

```sh
npm i -g @muninn/cli
muninn doctor
muninn serve
muninn install all
```

`muninn install all` configures Codex and Claude Code host integrations. It registers the Muninn MCP server and Stop hooks for those hosts. `mcp/` remains a protocol adapter package; there is no `muninn install mcp` target.

The first release does not install a background service, does not perform background updates, does not support Windows, and requires local native compilation with Rust and `protoc`.

## Documentation

- `docs/product/`
  - Product framing, milestones, and execution plans.
- `docs/spec/`
  - Canonical protocol and format specifications.
- `docs/architecture/`
  - System design, server API, observer design, and integration decisions.
- `docs/comparison/`
  - Comparison notes against related tools and workflows.
- `docs/research/`
  - Research notes, audits, and naming studies.
- `docs/workstreams/`
  - Briefs and progress notes for active workstreams.

Start with [docs/README.md](docs/README.md) for the simplified documentation map.

## Native Development

`@muninn/server` now talks to Rust through a `napi-rs` native addon.

Local prerequisites:

- Rust toolchain with `cargo`
- Node.js and `pnpm`
- `protoc`

Runtime prerequisites:

- `@muninn/server` bootstraps the observer and validates semantic index dimensions on first use.
- `muninn.json` therefore needs a complete runtime config for normal startup: `observer`, `extractor`, and `providers`.
- The current runtime does not support a turn/session-only startup path without observer config.

Main local build entrypoint:

```bash
pnpm --filter @muninn/server build
```

That command builds the native addon first and then compiles the TypeScript package.
