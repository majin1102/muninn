# Muninn

Muninn is a memory format and framework for agent-generated context. It automatically captures real-time context from Codex, Claude Code, and other agents, turning conversations, documents, images, and webpages into provenance-aware, multi-modal context lakes. Muninn pipelines curate raw context into grounded, source-linked layered memory for human-and-agent browsing, inspection, recall, and LLM-Wiki generation. Shared across agents and sessions, those memories compound experience and knowledge, helping agents continuously learn, evolve, and grow with you and your projects over time.

## Quick Start

Local prerequisites:

- Node.js 20+ and `pnpm`
- Rust toolchain with `cargo`
- `protoc`
- Python 3 for benchmark work
- Xcode/Swift only for the macOS shell

Install dependencies:

```bash
pnpm install
```

Build the main runtime:

```bash
pnpm --filter @muninn/web build
pnpm --filter @muninn/server build
```

Run the server directly from the workspace:

```bash
MUNINN_HOME=/tmp/muninn pnpm --filter @muninn/server start
```

The server defaults to `http://127.0.0.1:8080` and serves the app at `/app/` when `web/dist` is available. Runtime data defaults to `~/.muninn` unless `MUNINN_HOME` is set.

For the CLI path, build the CLI and run it from `dist`:

```bash
pnpm --filter @muninn/cli build
node cli/dist/cli.js doctor
node cli/dist/cli.js serve
node cli/dist/cli.js install all --dry-run
```

The installable CLI surface is centered on `@muninn/cli`:

```sh
npm i -g @muninn/cli
muninn doctor
muninn serve
muninn install all
```

`muninn serve` runs the server in the foreground. The first release path supports macOS and Linux, does not install a background service or updater, and requires local native compilation with Rust and `protoc`.

## Configuration

Muninn reads `muninn.json` from `MUNINN_HOME`:

```text
$MUNINN_HOME/muninn.json
```

The active runtime requires:

- `extractor`
- `observer` unless `observer.enabled` is `false`
- `providers.llm`
- `providers.embedding`

The web settings API exposes a default mock-provider config for local setup. Saving settings updates the file on disk; restart the server for runtime config changes to apply.

## Repository Layout

- `cli/`
  - `@muninn/cli`; runs `doctor`, `serve`, host install/uninstall, and status commands.
- `server/`
  - HTTP service, request validation, response shaping, local process-facing APIs, and the TypeScript memory runtime.
  - Loads the `napi-rs` native addon from `server/native`.
- `format/`
  - Rust typed-table, format, and storage implementation.
  - Defaults to the published `lance` crate; see `format/README.md` for the local override workflow.
- `web/`
  - Browser/WKWebView UI served by the server at `/app/`.
- `mcp/`
  - MCP adapter package. It should forward to `server`, not own backend logic.
- `common/`
  - Shared TypeScript contracts and pure agent hook helpers.
- `codex/`, `claude/`
  - Codex and Claude Code hook/adaptor integrations.
- `openclaw/plugin/`
  - OpenClaw plugin integration code and tests.
- `apple/macos/`
  - SwiftUI macOS host that bundles the server runtime and loads the web UI in WKWebView.
- `benchmark/`
  - Evaluation modules, including the LoCoMo benchmark adapter.
- `docs/`
  - Product notes, specs, architecture notes, comparisons, release runbooks, research notes, and workstream trackers.

Start with `docs/README.md` for the documentation map.

## Main HTTP Surface

Core service routes:

- `GET /health`
- `GET /version`
- `GET /api/v1/recall`
- `GET /api/v1/list`
- `GET /api/v1/timeline`
- `GET /api/v1/detail`
- `POST /api/v1/turn/capture`
- `GET /api/v1/memory/watermark`
- `POST /api/v1/memory/finalize`

UI routes live under `/app/` and `/api/v1/ui/*`. Benchmark-only LoCoMo routes live under `/api/v1/benchmark/locomo/*`.

The current persisted row unit is a `turn`; the public memory layer for those rows is `SESSION`. `session_id` is an optional grouping key, not the storage identity.

## Development Checks

Common checks:

```bash
pnpm --filter @muninn/common test
pnpm --filter @muninn/codex test
pnpm --filter @muninn/claude test
pnpm --filter @muninn/web build
pnpm --filter @muninn/web test
pnpm --filter @muninn/server test
pnpm --filter @muninn/benchmark-locomo test
cargo check --manifest-path format/Cargo.toml
cargo check --manifest-path server/native/Cargo.toml
```

Agent E2E:

```bash
pnpm test:e2e
```

macOS shell compile check:

```bash
swift build --package-path apple/macos
```

Maintainer note: produce release artifacts with `pnpm pack` or `pnpm publish`. pnpm rewrites `workspace:*` dependencies to concrete package versions in packed and published manifests. `npm pack` is useful for contents inspection only; it is not the release artifact path for this workspace.
