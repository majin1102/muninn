# Muninn AGENTS

This file is the fast-path context for coding agents working in this repository.

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

## Milestone 1

Milestone 1 exists to validate the first real product value of Muninn.

Product statement:

- Muninn gives an agent a small but usable working memory.
- The agent can save what just happened.
- The agent can later pull back the most relevant or most recent context.
- The returned context is directly usable for the next LLM step.

Milestone 1 product capabilities:

- Save a session memory row while an agent is working
- Browse the recent working context
- Search past session memory rows by text
- Open a single memory by `memoryId`
- Expand around a memory to recover nearby context
- Keep the memory available across local process restarts
- Access the same read capabilities through MCP

Milestone 1 user story:

- An agent completes a task step and writes a session memory row
- Later, the same or another agent asks what happened recently or what was said about a topic
- Muninn returns a small set of records in chronological order that can be injected into prompt context
- The agent continues work without manually reconstructing history

Milestone 1 in-scope implementation:

- Sidecar write path for adding a message into a logical session via `POST /api/v1/session/messages`
- Lance-backed local persistence through `packages/core` and the Rust daemon
- Read APIs: `recall`, `list`, `detail`, `timeline`
- MCP tools that expose those read APIs to agents
- Stable `memoryId` navigation in the form `{memoryLayer}:{memoryPoint}`
- Chronological ordering for recency windows when the output is intended for LLM context injection
- Basic end-to-end tests covering write, persist, list, recall, detail, and timeline

Milestone 1 out-of-scope:

- `thinking` write schema
- `observation` write schema
- semantic embeddings or vector recall
- policy/ranking strategy layers
- multi-layer recall across `thinking`, `observation`, `session`, and `turn`
- remote sync, multi-device replication, or cloud backends
- UI-specific sorting or presentation requirements

Milestone 1 is successful when:

- An agent can write session memory rows during execution
- Those records remain available after restarting sidecar/core
- The agent can retrieve useful context through `recall`, `list`, `detail`, and `timeline`
- Returned records can be injected into LLM context without extra reshaping
- MCP can consume the read path without direct knowledge of Rust/core internals

## Do

- Keep `mcp` thin.
- Keep transport concerns in `sidecar`.
- Put MCP protocol and schema evolution in `docs/spec/`.
- Use `session` for the current persisted unit.
- Treat Rust as the future home of core logic.
- Use a local Cargo `[patch.crates-io]` override when developing against a local Lance checkout.
- During MVP-stage development, remove obsolete code paths and interfaces instead of preserving compatibility layers that are no longer needed.

## Do Not

- Do not move business logic into `mcp`.
- Do not rename session memory to `conversation`.
- Do not use a top-level `mcp/` docs folder for protocol evolution.
- Do not overload transport adapters with future core-binding responsibilities.
- Do not commit a repository-external `path` dependency for the `lance` crate.
- Do not keep temporary compatibility shims once the underlying MVP model has changed and the old path no longer needs to exist.

## Likely Next Moves

- Continue consolidating TS integration work into `packages/core`.
- Gradually move demo logic from TypeScript toward Rust-backed implementation.
- Keep long-lived MCP protocol definitions under `docs/spec/`.
