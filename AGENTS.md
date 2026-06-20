# Muninn AGENTS

This file is the fast-path context for coding agents working in this repository.

## Repository Constraints

- After opening a PR, do not mark it as draft; open it directly as ready for review.
- Do not design or implement for forward compatibility. This repository is still in a rapid iteration stage, so when a schema or interface changes, update the code to the new shape only and remove obsolete compatibility handling instead of preserving support for historical versions.
- Describe all code review findings in Chinese.
- PR titles must follow the `Conventional Commits` style, such as `feat: ...`, `fix: ...`, and `docs: ...`. Use a valid type prefix followed by a short summary, do not open PRs with arbitrary title formats, and when developing a new feature always start by creating a new worktree from `main` with a new branch, then use that branch to implement the work and open the PR.
- Prefer short, context-aware names for methods and variables. Avoid sentence-like names that restate the entire workflow; both method names and variable names should stay compact when the surrounding code already provides the domain context. For example, prefer `link_refs(thread, refs)` over `resolve_pending_parent_references_after_flush(thread, refs)`, and prefer `pending_parent_id` over `pending_parent_reference_id`.
- When a plan includes prompt changes, spell out the concrete prompt text or exact prompt diff in the plan instead of describing it vaguely.

## What This Repo Is

Muninn is a memory format and framework for agent-generated context.

Product positioning:

- Muninn automatically captures real-time context from Codex, Claude Code, and other agents.
- Muninn turns conversations, documents, images, and webpages into provenance-aware, multi-modal context lakes.
- Muninn pipelines distill raw context into grounded, source-linked layered memory for human-and-agent browsing, inspection, recall, and LLM-Wiki generation.
- Shared across agents and sessions, those memories compound experience and knowledge so agents can continuously learn, evolve, and grow with the user and their projects over time.
- Muninn is not a raw transcript archive, a generic vector database wrapper, a note-taking app, a cloud collaboration service, or a hosted knowledge base.

Current strategic direction:

- Rust owns the long-term storage and format logic.
- TypeScript owns the current CLI, server shell, integration adapters, web UI, and transport surfaces.
- MCP protocol evolution belongs under `docs/spec/`.

## Current Module Map

- `cli/`
  - `@muninn/cli`.
  - Owns `doctor`, `run`, `start`, `stop`, `restart`, host install/uninstall, and status commands.
  - Normal users should enter through this package instead of invoking subpackages directly.
- `server/`
  - Single backend entrypoint for normal operation.
  - Owns HTTP routes, request validation, response shaping, local process-facing APIs, and the TypeScript memory runtime under `server/src/memory`.
  - Reads and writes Lance-backed tables through `server/native`.
  - Serves the built web app at `/app/`.
- `format/`
  - Rust typed-table, format, and storage implementation.
  - Defaults to the published `lance` crate; see `format/README.md` for local override workflow.
- `web/`
  - Browser/WKWebView UI for the Muninn app.
  - Talks to `server` through HTTP APIs and shared contracts from `common`.
- `mcp/`
  - MCP adapter layer.
  - Exposes MCP tools and forwards requests to the server.
  - Should remain thin and protocol-focused.
- `common/`
  - Shared TypeScript contracts and pure agent hook helpers.
- `codex/`
  - Codex adapter and hook integration.
- `claude/`
  - Claude Code adapter and hook integration.
- `openclaw/plugin/`
  - OpenClaw plugin integration code.
  - It is not listed in `pnpm-workspace.yaml`, but server tests build it directly when needed.
- `apple/macos/`
  - SwiftUI macOS host that starts the bundled server runtime, waits for `/health`, and loads `/app/` in WKWebView.
- `benchmark/`
  - Evaluation modules that run directly against Muninn.
  - `benchmark/locomo/` is the active LoCoMo adapter and scoring path.
- `docs/`
  - Design notes, product plans, specs, architecture notes, comparisons, release runbooks, research documents, and workstream trackers.
- `scripts/`
  - Repository-level helper scripts and E2E fixtures.

## Architecture

Preferred dependency direction:

- `server` may depend on `common`, `codex`, `claude`, and the Rust storage implementation through `server/native`.
- `server/src/memory` owns extractor, recall, watchdog, session, and turn orchestration.
- `format` owns typed tables, persistence, table maintenance, and Arrow/Lance conversion below the table API boundary.
- `web` should talk to `server` through HTTP APIs and shared contracts from `common`.
- `mcp` should talk to `server`, not directly to Rust/native by default.
- `codex` and `claude` should not depend on each other or on `web`.
- `cli` should orchestrate installed package commands and host config; it should not become a second backend.
- `apple/macos` should bundle and supervise the server/UI runtime; it should not duplicate memory business logic.

Working principle:

- `server` is the backend entrypoint.
- `mcp` is an adapter, not the business backend.
- Runtime configuration lives in `$MUNINN_HOME/muninn.json`.
- Saving config through the UI updates the file on disk; current runtime changes apply after restart.

## Current Truths

Current persisted record terminology:

- The persisted row unit is `turn`.
- The public memory layer for those rows is `SESSION`.
- `session_id` is only an optional grouping key.
- TypeScript interfaces are API/storage contracts, not the final relational schema.

Current write path:

- HTTP path: `POST /api/v1/turn/capture`
- Request type: `CaptureTurnRequest`
- Hook captures whose `metadata.ingest` ends in `-hook` are gated by the per-project capture allowlist.

Current runtime config requirements:

- `extractor` is required for core memory runtime.
- `providers.llm` and `providers.embedding` are required.
- Supported LLM provider types are `mock`, `openai`, and `openai-codex`.
- Supported embedding provider types are `mock` and `openai`.

Current installable surface:

- `@muninn/cli` is the user-facing package.
- `muninn run` runs the server in the foreground.
- `muninn start` starts a CLI-managed background process and returns.
- `muninn stop` stops that CLI-managed process.
- `muninn restart --force` force-restarts that CLI-managed process.
- `muninn install codex|claude|all` installs MCP and hook config for hosts.
- There is no `muninn install mcp` target.
- The first release path supports macOS and Linux, not Windows.
- Muninn does not install a background service or background updater.

## Useful Commands

Install:

```bash
pnpm install
```

Build:

```bash
pnpm --filter @muninn/server build
pnpm --filter @muninn/web build
pnpm run build:runtime
```

Run locally:

```bash
pnpm run build:runtime
MUNINN_HOME=/tmp/muninn pnpm muninn run
pnpm muninn doctor
```

Targeted checks:

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
swift build --package-path apple/macos
```

Agent E2E:

```bash
pnpm test:e2e
pnpm test:e2e:run
pnpm test:e2e:host
```

## Do

- Keep `mcp` thin.
- Keep transport concerns in `server`.
- Put MCP protocol and schema evolution in `docs/spec/`.
- Use current schema/interface shapes only; remove obsolete compatibility handling when shapes change.
- Keep Rust table APIs expressed in persisted/domain structs, not Arrow types.
- Keep Arrow/codec conversion below the Rust table boundary.
- Prefer focused module-local tests for narrow changes and broaden checks when touching shared contracts, native storage, or cross-agent behavior.

## Avoid

- Do not add backend business logic to `mcp`, `web`, `cli`, or `apple/macos`.
- Do not make Codex and Claude adapters depend on each other.
- Do not commit repository-external `path` dependencies for `lance`; use the local Cargo patch workflow from `format/README.md`.
- Do not preserve deprecated request/config shapes for compatibility unless the user explicitly asks for a migration layer.
