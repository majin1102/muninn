# Muninn AGENTS

This file is the fast-path context for coding agents working in this repository.

## Repository Constraints

- After opening a PR, do not mark it as draft; open it directly as ready for review.
- Do not design or implement for forward compatibility. This repository is still in an MVP-stage of iteration, so when a schema or interface changes, update the code to the new shape only and remove obsolete compatibility handling instead of preserving support for historical versions.
- Describe all code review findings in Chinese.
- PR titles must follow the `Conventional Commits` style, such as `feat: ...`, `fix: ...`, and `docs: ...`. Use a valid type prefix followed by a short summary, and do not open PRs with arbitrary title formats.

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
- `core/`
  - Intended long-term home of core logic and domain behavior.
  - Defaults to the published `lance` crate; see `core/README.md` for local override workflow.
- `docs/`
  - Design notes, product plans, specs, architecture notes, comparisons, research documents, and workstream trackers.
- `examples/`
  - Example code and runnable demos when needed.

## Architecture

Preferred dependency direction:

- `packages/sidecar` should depend on `packages/core`.
- `packages/core` should depend on the Rust core implementation.
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

- HTTP path: `POST /api/v1/session/messages`
- Request type: `AddMessageToSessionRequest`

Current session message write fields:

- `agent`
- `title`
- `summary`
- `tool_calling`
- `artifacts`
- `prompt`
- `response`
- `extra`

Current persisted fields added by storage:

- `turnId`
- `createdAt`
- `updatedAt`

Field semantics:

- `tool_calling` means tools invoked during the turn.
- `artifacts` means outputs produced by tool execution.
- `extra` means free-form API-layer input supplied by the client or adapter.

Important modeling note:

- Current TypeScript interfaces are API/storage contracts.
- They are not the final relational schema.

## Do

- Keep `mcp` thin.
- Keep transport concerns in `sidecar`.
- Put MCP protocol and schema evolution in `docs/spec/`.
- Use `session` for the current persisted unit.
- Treat Rust as the future home of core logic.
- Use a local Cargo `[patch.crates-io]` override when developing against a local Lance checkout.
- Remove obsolete code paths and interfaces instead of preserving compatibility layers that are no longer needed.

## Do Not

- Do not move business logic into `mcp`.
- Do not rename session memory to `conversation`.
- Do not use a top-level `mcp/` docs folder for protocol evolution.
- Do not overload transport adapters with future core-binding responsibilities.
- Do not commit a repository-external `path` dependency for the `lance` crate.
- Do not keep temporary compatibility shims once the underlying model has changed and the old path no longer needs to exist.

## Likely Next Moves

- Continue consolidating TS integration work into `packages/core`.
- Gradually move demo logic from TypeScript toward Rust-backed implementation.
- Keep long-lived MCP protocol definitions under `docs/spec/`.
