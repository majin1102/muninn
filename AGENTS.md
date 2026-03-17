# Munnai AGENTS

This file is the fast-path context for coding agents working in this repository.

## What This Repo Is

Munnai is a shared memory system for agents.

Current strategic direction:

- Rust is expected to become the long-term implementation language for core logic.
- TypeScript packages are the current integration and transport shell.
- MCP protocol evolution should happen under `spec/`.

## Current Module Map

- `packages/mcp`
  - MCP adapter layer.
  - Exposes MCP tools and forwards requests to the sidecar.
  - Should remain thin and protocol-focused.
- `packages/sidecar`
  - HTTP service layer.
  - Owns request validation, response shaping, and local process-facing APIs.
  - Currently persists demo data as local JSONL.
- `packages/types`
  - Shared TypeScript contracts.
  - Defines request, response, and record types used by TS packages.
- `packages/sdk`
  - Temporary thin TS client for sidecar HTTP calls.
  - Not the intended long-term core abstraction.
- `rust/`
  - Intended long-term home of core logic and domain behavior.
- `spec/`
  - Canonical location for protocol and schema evolution, especially MCP-related specs.
- `docs/`
  - Design notes, audits, comparisons, and research documents.
- `examples/`
  - Example code and runnable demos when needed.

## Architecture

Preferred dependency direction:

- `packages/sidecar` should depend on a future `packages/core` binding layer.
- `packages/core` should depend on the Rust core implementation.
- `packages/mcp` should talk to `packages/sidecar`, not directly to Rust/core by default.

Working principle:

- `sidecar` is the single backend entrypoint for normal operation.
- `mcp` is an adapter, not the business backend.

## Current Truths

Current persisted record terminology:

- The record unit is `turn`.
- It is not `message`.
- It is not `conversation`.

Current write path:

- HTTP path: `POST /api/v1/message/add`
- Request type: `AddTurnRequest`

Current `Turn` fields:

- `agent`
- `summary`
- `details`
- `tool_calling`
- `artifacts`
- `prompt`
- `response`

Current persisted fields added by storage:

- `turnId`
- `createdAt`

Field semantics:

- `tool_calling` means tools invoked during the turn.
- `artifacts` means outputs produced by tool execution.

Important modeling note:

- Current TypeScript interfaces are API/storage contracts.
- They are not the final relational schema.

## Do

- Keep `mcp` thin.
- Keep transport concerns in `sidecar`.
- Put MCP protocol and schema evolution in `spec/`.
- Use `turn` for the current persisted unit.
- Treat Rust as the future home of core logic.

## Do Not

- Do not move business logic into `mcp`.
- Do not rename turn-like records to `conversation`.
- Do not use a top-level `mcp/` docs folder for protocol evolution.
- Do not overload `sdk` with future core-binding responsibilities.

## Likely Next Moves

- Replace or rename `packages/sdk` with `packages/core` when Rust binding work starts.
- Gradually move demo logic from TypeScript toward Rust-backed implementation.
- Keep long-lived MCP protocol definitions under `spec/`.
