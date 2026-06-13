# Muninn AGENTS

This file is the fast-path context for coding agents working in this repository.

## Repository Constraints

- After opening a PR, do not mark it as draft; open it directly as ready for review.
- Do not design or implement for forward compatibility. This repository is still in an MVP-stage of iteration, so when a schema or interface changes, update the code to the new shape only and remove obsolete compatibility handling instead of preserving support for historical versions.
- Describe all code review findings in Chinese.
- PR titles must follow the `Conventional Commits` style, such as `feat: ...`, `fix: ...`, and `docs: ...`. Use a valid type prefix followed by a short summary, do not open PRs with arbitrary title formats, and when developing a new feature always start by creating a new worktree from `main` with a new branch, then use that branch to implement the work and open the PR.
- Prefer short, context-aware names for methods and variables. Avoid sentence-like names that restate the entire workflow; both method names and variable names should stay compact when the surrounding code already provides the domain context. For example, prefer `link_parent_refs(thread, refs)` over `resolve_pending_parent_references_after_flush(thread, refs)`, and prefer `pending_parent_id` over `pending_parent_observing_reference_id`.
- When a plan includes prompt changes, spell out the concrete prompt text or exact prompt diff in the plan instead of describing it vaguely.

## What This Repo Is

Muninn is a shared memory system for agents.

Current strategic direction:

- Rust is expected to become the long-term implementation language for storage/format logic.
- TypeScript modules are the current integration, agent adapter, web, and transport shell.
- MCP protocol evolution should happen under `docs/spec/`.

## Current Module Map

- `mcp/`
  - MCP adapter layer.
  - Exposes MCP tools and forwards requests to the server.
  - Should remain thin and protocol-focused.
- `server/`
  - HTTP service layer.
  - Owns request validation, response shaping, and local process-facing APIs.
  - Owns the TypeScript memory runtime under `server/src/memory`.
  - Reads and writes the Lance-backed turn dataset through `server/native`.
- `web/`
  - Browser/WKWebView UI for the Muninn app.
  - Talks to `server` through HTTP APIs.
- `common/`
  - Shared TypeScript contracts and pure agent hook helpers.
- `codex/`
  - Codex adapter and hook integration.
- `claude/`
  - Claude adapter and hook integration.
- `format/`
  - Rust typed-table, format, and storage implementation.
  - Defaults to the published `lance` crate; see `format/README.md` for local override workflow.
- `docs/`
  - Design notes, product plans, specs, architecture notes, comparisons, research documents, and workstream trackers.
- `examples/`
  - Example code and runnable demos when needed.

## Architecture

Preferred dependency direction:

- `server` may depend on `common`, `codex`, and `claude`.
- `server/src/memory` depends on the Rust `format/` implementation through `server/native`.
- `web` should talk to `server` through HTTP APIs and shared contracts from `common`.
- `mcp` should talk to `server`, not directly to Rust/native by default.
- `codex` and `claude` should not depend on each other or on `web`.

Working principle:

- `server` is the single backend entrypoint for normal operation.
- `mcp` is an adapter, not the business backend.

## Current Truths

Current persisted record terminology:

- The persisted row unit is `turn`.
- The public memory layer for those rows is `SESSION`.
- `session_id` is only an optional grouping key.

Current write path:

- HTTP path: `POST /api/v1/turn/capture`
- Request type: `CaptureTurnRequest`

Important modeling note:

- Current TypeScript interfaces are API/storage contracts.
- They are not the final relational schema.

## Do

- Keep `mcp` thin.
- Keep transport concerns in `sidecar`.
- Put MCP protocol and schema evolution in `docs/spec/`.
