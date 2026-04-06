# Muninn

Muninn is a memory layer for agents. This repository contains the Rust storage core, the TypeScript product/runtime packages, the OpenClaw plugin, and the project documentation.

## Repository Layout

- `core/`
  - Rust typed-table and storage implementation.
  - Also powers the Node native binding used by `@muninn/core`.
- `packages/`
  - TypeScript workspace for the sidecar, MCP adapter, shared types, board UI, and the main Muninn runtime.
- `openclaw/`
  - OpenClaw integration and plugin code.
- `docs/`
  - Product notes, specs, architecture documents, comparisons, research notes, and workstream trackers.

## Documentation

- `docs/product/`
  - Product framing, milestones, and execution plans.
- `docs/spec/`
  - Canonical protocol and format specifications.
- `docs/architecture/`
  - System design, sidecar API, observer design, and integration decisions.
- `docs/comparison/`
  - Comparison notes against related tools and workflows.
- `docs/research/`
  - Research notes, audits, and naming studies.
- `docs/workstreams/`
  - Briefs and progress notes for active workstreams.

Start with [docs/README.md](docs/README.md) for the simplified documentation map.

## Native Development

`@muninn/core` now talks to Rust through a `napi-rs` native addon.

Local prerequisites:

- Rust toolchain with `cargo`
- Node.js and `pnpm`
- `protoc`

Main local build entrypoint:

```bash
pnpm --filter @muninn/core build
```

That command builds the native addon first and then compiles the TypeScript package.
