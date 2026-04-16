# Muninn AGENTS

This file is the fast-path context for coding agents working in this repository.

## Repository Constraints

- After opening a PR, do not mark it as draft; open it directly as ready for review.
- Do not design or implement for forward compatibility. This repository is still in an MVP-stage of iteration, so when a schema or interface changes, update the code to the new shape only and remove obsolete compatibility handling instead of preserving support for historical versions.
- Describe all code review findings in Chinese.
- PR titles must follow the `Conventional Commits` style, such as `feat: ...`, `fix: ...`, and `docs: ...`. Use a valid type prefix followed by a short summary, do not open PRs with arbitrary title formats, and when developing a new feature always start by creating a new worktree from `main` with a new branch, then use that branch to implement the work and open the PR.
- When operating on `main`, treat the current conversation as the coordination thread. Use it for planning, review, and integration, and delegate each independent implementation task to its own sub-agent.
- For each independent feature or bugfix, create a new worktree from `main` and do the work on a dedicated branch. Reuse an existing worktree and task conversation only for small follow-up edits within the same task.
- Use short task-based branch names without a `codex/` prefix.
- Prefer short, context-aware names for methods and variables. Avoid sentence-like names that restate the entire workflow; both method names and variable names should stay compact when the surrounding code already provides the domain context. For example, prefer `link_parent_refs(thread, refs)` over `resolve_pending_parent_references_after_flush(thread, refs)`, and prefer `pending_parent_id` over `pending_parent_observing_reference_id`.

## What This Repo Is

Muninn is a shared memory system for agents.

Current strategic direction:

- Rust is expected to become the long-term implementation language for core logic.
- TypeScript packages are the current integration and transport shell.
- MCP protocol evolution should happen under `docs/spec/`.

## Current Module Map

- `packages/mcp`
  - MCP adapter layer.
  - Exposes MCP tools and forwards requests to the sidecar.
  - Should remain thin and protocol-focused.
- `packages/sidecar`
  - HTTP service layer.
  - Owns request validation, response shaping, and local process-facing APIs.
  - Reads and writes the Lance-backed turn dataset through `@muninn/core`.
- `packages/types`
  - Shared TypeScript contracts.
  - Defines request, response, and record types used by TS packages.
- `packages/core`
  - TS binding layer for the Lance-backed core implementation.
  - Shared entrypoint for sidecar and other TS integrations.
- `format/`
  - Rust typed-table, format, and storage implementation.
  - Defaults to the published `lance` crate; see `format/README.md` for local override workflow.
- `docs/`
  - Design notes, product plans, specs, architecture notes, comparisons, research documents, and workstream trackers.
- `examples/`
  - Example code and runnable demos when needed.

## Architecture

Preferred dependency direction:

- `packages/sidecar` should depend on `packages/core`.
- `packages/core` should depend on the Rust `format/` implementation.
- `packages/mcp` should talk to `packages/sidecar`, not directly to Rust/core by default.

Working principle:

- `sidecar` is the single backend entrypoint for normal operation.
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
