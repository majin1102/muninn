# Muninn Module Architecture Simplification Design

## Summary

Muninn should move toward a flatter product-oriented workspace:

```text
common/
web/
server/
mcp/
codex/
claude/
format/
apple/
benchmark/
openclaw/
```

The design removes the historical `packages/` container, renames the browser UI module to `web`, replaces `types` with `common`, splits Claude-specific adapter code out of `codex`, and folds the current `core` runtime into `server`.

The resulting model treats Muninn as a local server runtime with multiple entrypoints: web UI, MCP adapter, agent hooks, benchmarks, and macOS host.

## Goals

- Make top-level modules match product/runtime concepts instead of historical package placement.
- Keep shared contracts and pure helper code in one minimal shared package.
- Keep the browser UI independent from server, Codex, and Claude source code.
- Make `server` the single backend runtime that owns HTTP APIs, memory runtime, and native storage boundary.
- Keep MCP as an independent protocol adapter.
- Split Codex and Claude into independent agent adapters with shared hook helpers in `common`.
- Remove `packages/` entirely.

## Non-Goals

- Do not preserve compatibility paths such as `packages/server` or `packages/core`.
- Do not keep both `types` and `common`.
- Do not expose MCP tool schema from `common`.
- Do not make `web` import `server`, `codex`, or `claude`.
- Do not make `server build` responsible for building `web`.
- Do not redesign HTTP API paths as part of this module rename.

## Target Modules

### `common/`

Package name: `@muninn/common`.

`common` replaces the current `@muninn/types`. It contains shared Muninn contracts and pure helpers only.

Allowed content:

- API request and response types.
- Turn, session, artifact, memory document, recall, import, and capture contracts.
- Shared agent identifiers, labels, and metadata.
- Session identity helpers.
- Hook payload types shared by multiple agent adapters.
- Pure artifact/path/session normalization helpers shared by Codex and Claude.
- Small pure validation helpers that do not require filesystem, HTTP, native bindings, or process state.

Disallowed content:

- React or browser UI code.
- Hono or HTTP server code.
- MCP tool schema or protocol mapping.
- Codex-specific transcript parsing.
- Claude-specific transcript parsing.
- Filesystem IO.
- Native bindings.
- Lance/storage access.
- Observer, extractor, recall, or LLM runtime.

### `web/`

Package name: `@muninn/web`.

`web` is the browser/WKWebView UI. It is not a library for other packages to call.

Responsibilities:

- React/Vite application source.
- UI state, routes, styles, demo fixtures, and visual assets.
- Browser-side API client for server HTTP endpoints.
- Desktop bootstrap handling through `window.__MUNINN_DESKTOP__`.
- Build static assets into `web/dist`.

Dependencies:

```text
web -> common
web --HTTP--> server
```

`web` must not import `server`, `codex`, `claude`, `mcp`, or storage/runtime internals.

The product route remains `/app/`:

```text
GET /app/ -> server serves web/dist/index.html
GET /app/assets/... -> server serves web/dist assets
```

Directory and package names describe the technical module (`web`); URL path describes the product entrypoint (`/app/`).

### `server/`

Package name: `@muninn/server`.

`server` is the single backend runtime.

Responsibilities:

- Hono HTTP server and process entrypoint.
- Desktop bearer token auth.
- Settings endpoints.
- Capture endpoints.
- Import orchestration endpoints.
- Recall/search/session UI APIs.
- Artifact serving.
- Serving `web/dist` at `/app/`.
- Current `core` memory runtime after consolidation.
- Native binding boundary for `format`.

After folding in `core`, the server internal layout should stay explicit:

```text
server/src/http/
server/src/ui/
server/src/memory/
server/src/observer/
server/src/extractor/
server/src/llm/
server/native/
server/prompts/
```

The exact internal folder names can follow existing code shape during implementation, but the boundary is that these are server internals, not separate top-level packages.

Dependencies:

```text
server -> common
server -> codex
server -> claude
server -> format/native
```

`server` may depend on `codex` and `claude` because it owns import discovery and import orchestration. That is an adapter dependency, not a UI dependency.

`server` should not depend on `web` as a source package. Serving `web/dist` is a runtime/packaging relationship, configured through `MUNINN_WEB_DIST` or a known workspace path.

### `codex/`

Package name: `@muninn/codex`.

`codex` is an agent adapter for Codex-specific local data and hooks.

Responsibilities:

- Codex hook CLI, including `muninn-codex-hook`.
- Codex project/session discovery.
- Codex transcript parsing.
- Codex event to `common` turn/capture mapping.
- Codex artifact extraction.
- Codex import adapter consumed by `server`.

Dependencies:

```text
codex -> common
```

`codex` must not depend on `server`, `web`, `claude`, or `mcp`.

Hook runtime may post to the server HTTP API, but source code should model that through HTTP/client code, not direct server imports.

### `claude/`

Package name: `@muninn/claude`.

`claude` is an agent adapter for Claude-specific local data and hooks.

Responsibilities:

- Claude hook CLI, including `muninn-claude-hook`.
- Claude project/session discovery.
- Claude transcript parsing.
- Claude event to `common` turn/capture mapping.
- Claude artifact extraction.
- Claude import adapter consumed by `server`.

Dependencies:

```text
claude -> common
```

`claude` must not depend on `server`, `web`, `codex`, or `mcp`.

Shared hook, artifact, path, and identity helpers used by both `codex` and `claude` belong in `common`.

### `mcp/`

Package name: `@muninn/mcp`.

`mcp` is an independent protocol adapter.

Responsibilities:

- MCP server entrypoint.
- MCP tool definitions.
- MCP protocol request/response mapping.
- HTTP client calls to Muninn server.

Dependencies:

```text
mcp -> common
mcp --HTTP--> server
```

MCP tool schema stays in `mcp`, not in `common`.

### `format/`

`format` remains the Rust typed-table/storage implementation. It is consumed through the server native boundary after `core` is folded into `server`.

Dependency:

```text
server/native -> format
```

### `apple/`

`apple/macos` remains the native host.

Responsibilities:

- Launch bundled or development `server`.
- Set desktop env vars such as `HOST`, `PORT`, `MUNINN_HOME`, and `MUNINN_DESKTOP_TOKEN`.
- Load `http://127.0.0.1:<port>/app/` in WKWebView.
- Package `web/dist`, `server/dist`, native runtime artifacts, and bundled Node runtime.

It should not import TypeScript source.

### `benchmark/`

Benchmarks should move away from importing server internals. The preferred runtime path is server HTTP APIs.

During transition, direct imports from server internals may remain temporarily if needed to avoid expanding scope, but final direction is:

```text
benchmark -> common
benchmark --HTTP--> server
```

## Dependency Rules

Allowed source dependencies:

```text
web    -> common
server -> common
server -> codex
server -> claude
codex  -> common
claude -> common
mcp    -> common
```

Allowed runtime relationships:

```text
web browser code --HTTP--> server
mcp             --HTTP--> server
codex hook CLI  --HTTP--> server
claude hook CLI --HTTP--> server
apple launches server and loads /app/
server serves web/dist at /app/
```

Forbidden source dependencies:

```text
web -> server
web -> codex
web -> claude
web -> mcp
server -> web source
common -> web/server/codex/claude/mcp
codex -> server
claude -> server
codex -> claude
claude -> codex
mcp -> server source
```

## Build Model

Package builds should build only their own source and direct library dependencies.

Recommended scripts:

```text
common build: tsc
web build: common build + Vite build
codex build: common build + tsc
claude build: common build + tsc
server build: common build + codex build + claude build + server tsc/native build
mcp build: common build + tsc
```

Combined product builds should live at the root or in packaging scripts:

```text
root build:
  build common
  build web
  build codex
  build claude
  build server
  build mcp

apple packaging:
  build web
  build server
  stage web/dist
  stage server/dist
  stage server/native artifact
  stage Node runtime
```

`server build` should not build `web`; serving `web/dist` is a packaging/runtime relationship.

The static web dist env var should be:

```text
MUNINN_WEB_DIST=<path-to-web-dist>
```

## Migration Plan

1. Rename the browser UI module:

```text
client/ -> web/
@muninn/client -> @muninn/web
MUNINN_CLIENT_DIST -> MUNINN_WEB_DIST
```

2. Replace `types` with `common`:

```text
packages/types -> common
@muninn/types -> @muninn/common
```

Move only shared contracts and pure helpers into `common`.

3. Move server to the top level:

```text
packages/server -> server
```

Update macOS development lookup paths, benchmark spawn paths, OpenClaw live test paths, scripts, docs, and package scripts.

4. Move MCP to the top level:

```text
packages/mcp -> mcp
```

Keep MCP schema and protocol mapping inside `mcp`.

5. Split Claude from Codex:

```text
codex/ keeps Codex adapter and muninn-codex-hook
claude/ gets Claude adapter and muninn-claude-hook
shared hook helpers move to common
```

Update `server` to import both adapters explicitly.

6. Fold `core` into `server`:

```text
packages/core/src -> server/src/memory and adjacent runtime folders
packages/core/native -> server/native
packages/core/prompts -> server/prompts
@muninn/core imports removed
```

Move benchmarks/scripts toward server HTTP APIs. Temporary server-internal imports can be handled explicitly if needed during the transition.

7. Remove `packages/` and update workspace config:

```text
pnpm-workspace.yaml includes:
  common
  web
  server
  mcp
  codex
  claude
  benchmark/*
```

8. Move tests across boundaries:

- Tests under `web` must not read `server` source files.
- Endpoint tests belong under `server`.
- Shared helper tests belong under `common`.
- Agent parser tests belong under `codex` or `claude`.

## Validation

Workspace validation after migration:

```sh
source ~/.zprofile && pnpm --filter @muninn/common build
source ~/.zprofile && pnpm --filter @muninn/web build
source ~/.zprofile && pnpm --filter @muninn/codex test
source ~/.zprofile && pnpm --filter @muninn/claude test
source ~/.zprofile && pnpm --filter @muninn/server test
source ~/.zprofile && pnpm --filter @muninn/mcp build
```

Runtime validation:

- `server` serves `web/dist` at `/app/`.
- `web` can load from `/app/` and call `/api/v1/*`.
- Desktop bearer token still protects `/api/*` when configured.
- Codex hook capture posts to server.
- Claude hook capture posts to server.
- Codex import UI flow works through server endpoints.
- Claude import UI flow works through server endpoints.
- MCP starts and calls server through HTTP.
- macOS host launches server and loads `/app/`.

## Open Decisions Resolved

- The browser UI module is named `web`, not `client` or `app`.
- MCP remains an independent top-level module.
- MCP tool schemas remain in `mcp`, not `common`.
- Claude becomes a separate top-level module.
- `web` does not depend on `codex` or `claude`.
- `server` may depend on `codex` and `claude` adapters.
- `common` replaces `types`; there is no parallel `types` package.
- Current `core` is folded into `server` as internal backend runtime.
