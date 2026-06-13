# Module Architecture Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flatten Muninn into product-oriented top-level modules: `common`, `web`, `server`, `mcp`, `codex`, `claude`, with no `packages/` directory.

**Architecture:** `common` becomes the shared contracts and pure helpers package. `web` is the browser UI served at `/app/`; `server` is the backend runtime and eventually owns the former `core`; `mcp`, `codex`, and `claude` are adapters that depend on `common`. Build orchestration moves to root/package scripts so `server build` does not build `web`.

**Tech Stack:** pnpm workspaces, TypeScript, Vite/React, Hono, Node test runner, SwiftPM macOS host, Rust/native addon under `server/native`.

---

## File Structure

Final workspace module layout:

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

Primary package names:

```text
common/package.json   -> @muninn/common
web/package.json      -> @muninn/web
server/package.json   -> @muninn/server
mcp/package.json      -> @muninn/mcp
codex/package.json    -> @muninn/codex
claude/package.json   -> @muninn/claude
```

Module dependency rules:

```text
web    -> common
server -> common
server -> codex
server -> claude
codex  -> common
claude -> common
mcp    -> common
```

Runtime relationships:

```text
web --HTTP--> server
mcp --HTTP--> server
codex hook CLI --HTTP--> server
claude hook CLI --HTTP--> server
server serves web/dist at /app/
apple launches server and loads /app/
```

Implementation strategy:

- Keep commits small and buildable.
- Do path/package renames before behavior changes.
- Keep `/app/` URL unchanged.
- Do not preserve compatibility aliases or historical paths.
- Move tests that inspect server source out of `web` as part of the boundary cleanup.
- Use `git mv` for directory moves so file history stays readable.

## Task 0: Normalize Current In-Progress UI Rename Before Architecture Migration

**Files:**
- Modify: `client/package.json`
- Modify: `client/README.md`
- Modify: `client/src/lib/api.ts`
- Modify: `client/src/components/SessionTree.tsx`
- Modify: `packages/server/package.json`
- Modify: `packages/server/src/ui/app.ts`
- Modify: `pnpm-workspace.yaml`
- Modify: `apple/macos/README.md`
- Modify: `docs/board-interaction-style.md`
- Rename: `client/` to `web/`

This repository currently has an in-progress `app/ -> client/` rename in the worktree. Finish that rename into the agreed `web` target before broader migration.

- [ ] **Step 1: Rename `client/` to `web/`**

Run:

```bash
git mv client web
```

Expected: `git status --short` shows `app/... -> web/...` renames rather than `app/... -> client/...`.

- [ ] **Step 2: Update package and workspace names**

Edit `web/package.json`:

```json
{
  "name": "@muninn/web",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "pnpm --filter @muninn/types build && tsc -p tsconfig.json --noEmit && vite build && mkdir -p dist/assets && cp -R src/assets/. dist/assets/",
    "dev": "vite --host 127.0.0.1"
  },
  "dependencies": {
    "@muninn/types": "workspace:*",
    "@vitejs/plugin-react": "^5.0.0",
    "lucide-react": "^0.468.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-markdown": "^10.0.0",
    "remark-gfm": "^4.0.0",
    "vite": "^6.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0"
  }
}
```

Edit `pnpm-workspace.yaml`:

```yaml
packages:
  - 'web'
  - 'packages/*'
  - 'benchmark/*'
  - 'codex'
```

- [ ] **Step 3: Update web local storage keys**

Edit `web/src/lib/api.ts` so `resolveApiBase` and `resolveUsesDemoData` use web keys:

```ts
localStorage.setItem('muninn.web.apiBase', trimTrailingSlash(fromQuery));
const fromStorage = localStorage.getItem('muninn.web.apiBase');
localStorage.removeItem('muninn.web.dataMode');
```

Edit `web/src/components/SessionTree.tsx`:

```ts
const SESSION_TOOLBAR_STORAGE_KEY = 'muninn:web:session-toolbar-filter:v3';
```

- [ ] **Step 4: Update server static web dist naming**

Edit `packages/server/src/ui/app.ts`:

```ts
function resolveWebDistPath(): string {
  const candidates = [
    process.env.MUNINN_WEB_DIST,
    path.join(packageRoot, 'web', 'dist'),
    path.resolve(process.cwd(), '..', '..', 'web', 'dist'),
    path.resolve(process.cwd(), 'web', 'dist'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

function getWebAssetPath(relativePath: string): string {
  const normalized = path.posix.normalize(`/${relativePath}`).replace(/^\/+/, '');
  return path.join(resolveWebDistPath(), normalized);
}

async function serveWebFile(filePath: string): Promise<Response> {
  try {
    const content = await readFile(filePath);
    return new Response(content, {
      headers: {
        'content-type': contentTypeFor(filePath),
        'cache-control': 'no-store',
      },
    });
  } catch {
    return new Response('Not Found', { status: 404 });
  }
}
```

Update route handlers in the same file:

```ts
appRoutes.get('/app/', async () => {
  return serveWebFile(getWebAssetPath('index.html'));
});

appRoutes.get('/app/:asset{.+}', async (c) => {
  const asset = c.req.param('asset');
  if (asset.includes('..')) {
    return c.text('Not Found', 404);
  }
  return serveWebFile(getWebAssetPath(asset));
});
```

Edit `packages/server/package.json` build script:

```json
"build": "pnpm --filter @muninn/web build && pnpm --filter @muninn/codex build && pnpm --filter @muninn/core build && tsc"
```

This task keeps server building web temporarily. Task 6 removes that build coupling after root scripts exist.

- [ ] **Step 5: Update docs for web naming**

Edit `web/README.md` heading and build command:

```md
# Muninn Web

`@muninn/web` is Muninn's browser/WKWebView UI.

```bash
pnpm --filter @muninn/web build
```
```

Edit `apple/macos/README.md` resource layout:

```text
Resources/Server/
  bin/node
  web/dist/
  packages/server/dist/
  packages/core/dist/
  packages/core/native/muninn_native.node
  packages/types/dist/
  node_modules/
```

Edit `docs/board-interaction-style.md`:

```sh
source ~/.zprofile && pnpm --filter @muninn/web build
```

- [ ] **Step 6: Verify Task 0**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/web build
source ~/.zprofile && pnpm --filter @muninn/server build
source ~/.zprofile && node --test web/test/*.test.mjs
```

Expected:

```text
@muninn/web build exits 0
@muninn/server build exits 0
web tests pass
```

- [ ] **Step 7: Commit Task 0**

Run:

```bash
git add pnpm-workspace.yaml web packages/server apple/macos/README.md docs/board-interaction-style.md
git commit -m "refactor: rename web ui module"
```

Expected: commit succeeds with only `app/ -> web/` rename and related naming changes.

## Task 1: Rename `types` to `common`

**Files:**
- Rename: `packages/types/` to `common/`
- Modify: `common/package.json`
- Modify: `pnpm-workspace.yaml`
- Modify imports across `web/`, `server/`, `codex/`, `mcp/`, `benchmark/`, and tests
- Modify path aliases in `web/vite.config.ts`

- [ ] **Step 1: Move package directory**

Run:

```bash
git mv packages/types common
```

Expected: `common/package.json` exists and `packages/types` no longer exists.

- [ ] **Step 2: Rename package**

Edit `common/package.json`:

```json
{
  "name": "@muninn/common",
  "version": "0.1.0",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./session-identity": {
      "types": "./dist/session_identity.d.ts",
      "default": "./dist/session_identity.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  }
}
```

Edit `pnpm-workspace.yaml`:

```yaml
packages:
  - 'common'
  - 'web'
  - 'packages/*'
  - 'benchmark/*'
  - 'codex'
```

- [ ] **Step 3: Update package dependencies**

Replace dependency keys in package manifests:

```json
"@muninn/common": "workspace:*"
```

Apply to:

```text
web/package.json
codex/package.json
packages/server/package.json
packages/core/package.json
packages/mcp/package.json
```

Remove the old key:

```json
"@muninn/types": "workspace:*"
```

- [ ] **Step 4: Update TypeScript imports**

Replace:

```ts
from '@muninn/types'
from '@muninn/types/session-identity'
import('@muninn/types')
```

with:

```ts
from '@muninn/common'
from '@muninn/common/session-identity'
import('@muninn/common')
```

Apply to source and tests under:

```text
web/
codex/
packages/server/
packages/core/
packages/mcp/
benchmark/
```

- [ ] **Step 5: Update tests that read common source**

Edit `web/test/search-state.test.mjs` source path:

```js
const identitySource = await readFile(new URL('../../common/src/session_identity.ts', import.meta.url), 'utf8');
```

Edit `web/test/import-settings-source.test.mjs` type source paths:

```js
const typeSource = await readFile(new URL('../../common/src/api.ts', import.meta.url), 'utf8');
const identitySource = await readFile(new URL('../../common/src/session_identity.ts', import.meta.url), 'utf8');
```

Edit `web/vite.config.ts` alias:

```ts
'@muninn/common/session-identity': resolve(__dirname, '../common/src/session_identity.ts'),
```

- [ ] **Step 6: Update build scripts**

Replace script fragments:

```bash
pnpm --filter @muninn/types build
```

with:

```bash
pnpm --filter @muninn/common build
```

Apply in:

```text
web/package.json
codex/package.json
packages/core/package.json
packages/server/package.json
```

- [ ] **Step 7: Verify Task 1**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/common build
source ~/.zprofile && pnpm --filter @muninn/web build
source ~/.zprofile && pnpm --filter @muninn/server test
```

Expected:

```text
common build exits 0
web build exits 0
server tests pass
```

- [ ] **Step 8: Commit Task 1**

Run:

```bash
git add common web codex packages benchmark pnpm-workspace.yaml
git commit -m "refactor: rename shared types package to common"
```

Expected: commit succeeds and `rg "@muninn/types|packages/types" .` returns no active source references outside historical docs.

## Task 2: Move `server` to Top Level

**Files:**
- Rename: `packages/server/` to `server/`
- Modify: `pnpm-workspace.yaml`
- Modify: `apple/macos/Sources/Muninn/MuninnServer.swift`
- Modify: `apple/macos/README.md`
- Modify: `benchmark/locomo/test/bridge.test.mjs`
- Modify: `openclaw/plugin/test/helpers/paths.mjs`
- Modify source-reading tests under `web/test/`
- Modify scripts/docs that reference `packages/server`

- [ ] **Step 1: Move directory**

Run:

```bash
git mv packages/server server
```

Expected: `server/package.json` exists and `packages/server` no longer exists.

- [ ] **Step 2: Update workspace**

Edit `pnpm-workspace.yaml`:

```yaml
packages:
  - 'common'
  - 'web'
  - 'server'
  - 'packages/*'
  - 'benchmark/*'
  - 'codex'
```

- [ ] **Step 3: Update server package relative paths**

Edit `server/package.json` test script because the package moved from `packages/server` to `server`:

```json
"test": "(cd ../openclaw/plugin && pnpm build) && pnpm run build && node --test test/*.test.mjs"
```

Keep build dependencies unchanged at this stage.

- [ ] **Step 4: Update macOS server lookup paths**

Edit `apple/macos/Sources/Muninn/MuninnServer.swift`.

Replace every:

```swift
"packages/server/dist/index.js"
```

with:

```swift
"server/dist/index.js"
```

Update the missing resource message:

```swift
"Bundled server entry not found at \(bundleEntry.path). Dev server entry not found at \(devEntry.path). Run `pnpm --filter @muninn/server build` first."
```

The message text can remain the same because the package name stays `@muninn/server`.

- [ ] **Step 5: Update benchmark and OpenClaw paths**

Edit `benchmark/locomo/test/bridge.test.mjs`:

```js
const sidecar = spawn(process.execPath, [path.join(repoRoot, 'server/dist/index.js')], {
```

Edit `openclaw/plugin/test/helpers/paths.mjs`:

```js
"../../server/dist/index.js",
```

- [ ] **Step 6: Update web source-reading tests**

Edit `web/test/import-settings-source.test.mjs` and `web/test/session-tree-source.test.mjs`.

Replace:

```js
new URL('../../packages/server/src/ui/app.ts', import.meta.url)
new URL('../../packages/server/src/ui/capture_policy.ts', import.meta.url)
new URL('../../packages/server/src/ui/import_core.ts', import.meta.url)
new URL('../../packages/server/src/ui/codex_import.ts', import.meta.url)
new URL('../../packages/server/src/ui/claude_import.ts', import.meta.url)
```

with:

```js
new URL('../../server/src/ui/app.ts', import.meta.url)
new URL('../../server/src/ui/capture_policy.ts', import.meta.url)
new URL('../../server/src/ui/import_core.ts', import.meta.url)
new URL('../../server/src/ui/codex_import.ts', import.meta.url)
new URL('../../server/src/ui/claude_import.ts', import.meta.url)
```

These tests are moved to server in Task 7. This step keeps the suite passing after the path move.

- [ ] **Step 7: Update docs and scripts with active paths**

Edit `apple/macos/README.md` resource layout:

```text
Resources/Server/
  bin/node
  web/dist/
  server/dist/
  packages/core/dist/
  packages/core/native/muninn_native.node
  common/dist/
  node_modules/
```

Edit active scripts:

```text
scripts/run-session-extractor.mjs
scripts/clear-generated-memory.mjs
```

Do not change core paths in these scripts yet unless they reference server. Core migration happens later.

- [ ] **Step 8: Verify Task 2**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/server build
source ~/.zprofile && pnpm --filter @muninn/server test
source ~/.zprofile && swift build --package-path apple/macos
```

Expected:

```text
server build exits 0
server tests pass
Swift build exits 0
```

- [ ] **Step 9: Commit Task 2**

Run:

```bash
git add server web apple benchmark openclaw pnpm-workspace.yaml
git commit -m "refactor: move server module to top level"
```

Expected: commit succeeds and `rg "packages/server" .` only reports historical docs or planned future migration references.

## Task 3: Move `mcp` to Top Level

**Files:**
- Rename: `packages/mcp/` to `mcp/`
- Modify: `pnpm-workspace.yaml`
- Modify: active docs that reference `packages/mcp`

- [ ] **Step 1: Move directory**

Run:

```bash
git mv packages/mcp mcp
```

Expected: `mcp/package.json` exists and `packages/mcp` no longer exists.

- [ ] **Step 2: Update workspace**

Edit `pnpm-workspace.yaml`:

```yaml
packages:
  - 'common'
  - 'web'
  - 'server'
  - 'mcp'
  - 'packages/*'
  - 'benchmark/*'
  - 'codex'
```

- [ ] **Step 3: Verify MCP package remains protocol-only**

Run:

```bash
rg -n "from '@muninn/(server|web|codex|claude|core)'|packages/(server|core)" mcp/src mcp/test mcp/package.json
```

Expected: no output for forbidden source dependencies.

- [ ] **Step 4: Build MCP**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/mcp build
```

Expected: build exits 0.

- [ ] **Step 5: Commit Task 3**

Run:

```bash
git add mcp pnpm-workspace.yaml
git commit -m "refactor: move mcp module to top level"
```

Expected: commit succeeds.

## Task 4: Split Claude Adapter Out of Codex

**Files:**
- Create: `claude/package.json`
- Create: `claude/tsconfig.json`
- Create: `claude/src/claude-cli.ts`
- Create: `claude/src/claude.ts`
- Create: `claude/test/claude.test.mjs`
- Modify: `codex/package.json`
- Modify: `codex/src/mapping.ts`
- Move: `codex/src/claude-cli.ts` to `claude/src/claude-cli.ts`
- Modify: `server/src/ui/claude_import.ts`
- Modify: `server/package.json`
- Modify: `pnpm-workspace.yaml`

- [ ] **Step 1: Inspect current Codex/Claude files**

Run:

```bash
rg -n "claude|Claude|CLAUDE|muninn-claude-hook" codex server/src/ui server/test
```

Expected: output identifies current Claude CLI and parser/import locations.

- [ ] **Step 2: Create Claude package manifest**

Create `claude/package.json`:

```json
{
  "name": "@muninn/claude",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/claude.d.ts",
      "default": "./dist/claude.js"
    }
  },
  "bin": {
    "muninn-claude-hook": "./dist/claude-cli.js"
  },
  "scripts": {
    "build": "pnpm --filter @muninn/common build && tsc -p tsconfig.json",
    "test": "pnpm build && node --test test/**/*.test.mjs"
  },
  "dependencies": {
    "@muninn/common": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0"
  }
}
```

- [ ] **Step 3: Create Claude tsconfig**

Create `claude/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "declaration": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  },
  "include": [
    "src/**/*.ts"
  ]
}
```

- [ ] **Step 4: Move Claude CLI**

Run:

```bash
git mv codex/src/claude-cli.ts claude/src/claude-cli.ts
```

Edit imports in `claude/src/claude-cli.ts` so they reference `./claude.js` for Claude-specific mapping code and `@muninn/common` for shared contracts.

Expected import pattern:

```ts
import type { CaptureTurnRequest } from '@muninn/common';
import { readClaudeSession, readClaudeSessionSummary } from './claude.js';
```

- [ ] **Step 5: Split Claude mapping/parser exports**

Create `claude/src/claude.ts` by moving these Claude-specific exports out of `codex/src/mapping.ts`:

Expected public exports:

```ts
export const CLAUDE_AGENT = 'claude-code';
export const CLAUDE_MARKER_KEY = 'claudeImport';
export { readClaudeSession, readClaudeSessionSummary };
```

Keep Codex-specific exports in `codex/src/mapping.ts`, including Codex constants, Codex session parsing, and Codex hook mapping.

- [ ] **Step 6: Update Codex package bin and exports**

Edit `codex/package.json` so it no longer owns Claude hook CLI:

```json
"bin": {
  "muninn-codex-hook": "./dist/cli.js"
}
```

Keep Codex exports Codex-specific.

- [ ] **Step 7: Update server Claude imports**

Edit `server/src/ui/claude_import.ts`.

Replace:

```ts
import { CLAUDE_AGENT, CLAUDE_MARKER_KEY, readClaudeSession, readClaudeSessionSummary } from '@muninn/codex';
```

with:

```ts
import { CLAUDE_AGENT, CLAUDE_MARKER_KEY, readClaudeSession, readClaudeSessionSummary } from '@muninn/claude';
```

Edit `server/package.json` dependencies:

```json
"@muninn/claude": "workspace:*"
```

Edit build script:

```json
"build": "pnpm --filter @muninn/codex build && pnpm --filter @muninn/claude build && pnpm --filter @muninn/core build && tsc"
```

At this stage the build script may still include `@muninn/core`; that is removed after core consolidation.

- [ ] **Step 8: Update workspace**

Edit `pnpm-workspace.yaml`:

```yaml
packages:
  - 'common'
  - 'web'
  - 'server'
  - 'mcp'
  - 'codex'
  - 'claude'
  - 'packages/*'
  - 'benchmark/*'
```

- [ ] **Step 9: Add Claude smoke test**

Create `claude/test/claude.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_AGENT, CLAUDE_MARKER_KEY } from '../dist/claude.js';

test('claude adapter exports stable agent markers', () => {
  assert.equal(CLAUDE_AGENT, 'claude-code');
  assert.equal(CLAUDE_MARKER_KEY, 'claudeImport');
});
```

- [ ] **Step 10: Verify Task 4**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/codex test
source ~/.zprofile && pnpm --filter @muninn/claude test
source ~/.zprofile && pnpm --filter @muninn/server test
```

Expected:

```text
codex tests pass
claude tests pass
server tests pass
```

- [ ] **Step 11: Commit Task 4**

Run:

```bash
git add codex claude server pnpm-workspace.yaml
git commit -m "refactor: split claude adapter from codex"
```

Expected: commit succeeds and `rg "claude" codex/src codex/package.json` only reports Codex docs/tests if intentionally retained.

## Task 5: Move Shared Agent Hook Helpers into Common

**Files:**
- Create: `common/src/agents.ts`
- Create or modify: `common/src/artifacts.ts`
- Modify: `common/src/index.ts`
- Modify: `codex/src/*`
- Modify: `claude/src/*`
- Add: `common/test/agents.test.mjs`

- [ ] **Step 1: Identify duplicated helper code**

Run:

```bash
rg -n "safe|artifact|path|sessionIdentity|agent|capture payload|CaptureTurnRequest" codex/src claude/src common/src
```

Expected: output identifies helpers currently duplicated or agent-generic.

- [ ] **Step 2: Add shared agent metadata**

Create `common/src/agents.ts`:

```ts
export const CODEX_AGENT = 'codex' as const;
export const CLAUDE_AGENT = 'claude-code' as const;

export type MuninnAgent = typeof CODEX_AGENT | typeof CLAUDE_AGENT;

export function agentLabel(agent: MuninnAgent): string {
  switch (agent) {
    case CODEX_AGENT:
      return 'Codex';
    case CLAUDE_AGENT:
      return 'Claude Code';
  }
}
```

Edit `common/src/index.ts`:

```ts
export * from './agents.js';
```

- [ ] **Step 3: Add common agent test**

Create `common/test/agents.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_AGENT, CLAUDE_AGENT, agentLabel } from '../dist/agents.js';

test('agent constants and labels are stable', () => {
  assert.equal(CODEX_AGENT, 'codex');
  assert.equal(CLAUDE_AGENT, 'claude-code');
  assert.equal(agentLabel(CODEX_AGENT), 'Codex');
  assert.equal(agentLabel(CLAUDE_AGENT), 'Claude Code');
});
```

If `common/package.json` does not have a test script, add:

```json
"test": "pnpm build && node --test test/*.test.mjs"
```

- [ ] **Step 4: Update codex and claude to import common constants**

Edit Codex and Claude adapter files.

Replace local constants:

```ts
export const CODEX_AGENT = 'codex';
export const CLAUDE_AGENT = 'claude-code';
```

with:

```ts
export { CODEX_AGENT } from '@muninn/common';
export { CLAUDE_AGENT } from '@muninn/common';
```

Keep adapter-specific marker constants local:

```ts
export const CLAUDE_MARKER_KEY = 'claudeImport';
```

- [ ] **Step 5: Verify Task 5**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/common test
source ~/.zprofile && pnpm --filter @muninn/codex test
source ~/.zprofile && pnpm --filter @muninn/claude test
source ~/.zprofile && pnpm --filter @muninn/server test
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit Task 5**

Run:

```bash
git add common codex claude server
git commit -m "refactor: share agent helpers through common"
```

Expected: commit succeeds.

## Task 6: Decouple Server Build from Web Build

**Files:**
- Modify: `package.json`
- Modify: `server/package.json`
- Modify: `server/src/ui/app.ts`
- Modify: `apple/macos/README.md`
- Modify: `web/README.md`

- [ ] **Step 1: Add root build scripts**

Edit root `package.json`:

```json
{
  "name": "muninn",
  "version": "0.1.0",
  "private": true,
  "packageManager": "pnpm@9.0.0",
  "scripts": {
    "build": "pnpm -r build",
    "build:runtime": "pnpm --filter @muninn/web build && pnpm --filter @muninn/server build",
    "dev": "pnpm -r dev"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  }
}
```

- [ ] **Step 2: Remove web build from server build**

Edit `server/package.json`:

```json
"build": "pnpm --filter @muninn/codex build && pnpm --filter @muninn/claude build && pnpm --filter @muninn/core build && tsc"
```

Do not include `@muninn/web`.

- [ ] **Step 3: Confirm server has only runtime web dist lookup**

Edit `server/src/ui/app.ts` so the only web relationship is the runtime dist lookup:

```ts
process.env.MUNINN_WEB_DIST
path.join(packageRoot, 'web', 'dist')
```

There must be no import from `@muninn/web` and no `pnpm --filter @muninn/web` in `server/package.json`.

- [ ] **Step 4: Update docs**

Edit `web/README.md` build section:

```md
Build web only:

```bash
pnpm --filter @muninn/web build
```

Build runnable local runtime:

```bash
pnpm run build:runtime
```
```

Edit `apple/macos/README.md` packaging note:

```md
Developer ID packaging stages `web/dist` and `server/dist`; build both with `pnpm run build:runtime` before packaging.
```

- [ ] **Step 5: Verify Task 6**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/server build
source ~/.zprofile && pnpm run build:runtime
```

Expected:

```text
server build exits 0 without invoking @muninn/web build
build:runtime invokes @muninn/web build and @muninn/server build
```

- [ ] **Step 6: Commit Task 6**

Run:

```bash
git add package.json server/package.json server/src/ui/app.ts web/README.md apple/macos/README.md
git commit -m "refactor: decouple server build from web build"
```

Expected: commit succeeds.

## Task 7: Move Web Tests That Inspect Server Source into Server

**Files:**
- Move relevant tests from `web/test/import-settings-source.test.mjs` to `server/test/import-settings-source.test.mjs`
- Move relevant tests from `web/test/session-tree-source.test.mjs` to `server/test/session-tree-source.test.mjs`
- Modify remaining web tests to inspect only web source

- [ ] **Step 1: Identify server-source assertions in web tests**

Run:

```bash
rg -n "server/src|serverSource|capturePolicySource|importSource|codexImportSource|claudeImportSource" web/test
```

Expected: output lists tests that violate the web boundary.

- [ ] **Step 2: Create server import settings source test**

Create `server/test/import-settings-source.test.mjs` by moving server-source assertions from `web/test/import-settings-source.test.mjs`.

Use server-local paths:

```js
const serverSource = await readFile(new URL('../src/ui/app.ts', import.meta.url), 'utf8');
const capturePolicySource = await readFile(new URL('../src/ui/capture_policy.ts', import.meta.url), 'utf8');
const importSource = await readFile(new URL('../src/ui/import_core.ts', import.meta.url), 'utf8');
const codexImportSource = await readFile(new URL('../src/ui/codex_import.ts', import.meta.url), 'utf8');
const claudeImportSource = await readFile(new URL('../src/ui/claude_import.ts', import.meta.url), 'utf8');
```

Keep assertion bodies unchanged, except update any package names from `@muninn/types` to `@muninn/common`.

- [ ] **Step 3: Create server session tree source test**

Create `server/test/session-tree-source.test.mjs` by moving server-source assertions from `web/test/session-tree-source.test.mjs`.

Use:

```js
const serverSource = await readFile(new URL('../src/ui/app.ts', import.meta.url), 'utf8');
```

- [ ] **Step 4: Remove server-source reads from web tests**

Edit `web/test/import-settings-source.test.mjs` and `web/test/session-tree-source.test.mjs`.

Remove tests that read files under `../server/src`. Keep only tests that inspect:

```text
web/src/*
common/src/*
```

- [ ] **Step 5: Verify web boundary**

Run:

```bash
rg -n "server/src|serverSource|capturePolicySource|importSource|codexImportSource|claudeImportSource" web/test
```

Expected: no output.

- [ ] **Step 6: Run tests**

Run:

```bash
source ~/.zprofile && node --test web/test/*.test.mjs
source ~/.zprofile && pnpm --filter @muninn/server test
```

Expected:

```text
web tests pass
server tests pass
```

- [ ] **Step 7: Commit Task 7**

Run:

```bash
git add web/test server/test
git commit -m "test: move server source assertions out of web"
```

Expected: commit succeeds.

## Task 8: Fold Core into Server Runtime

**Files:**
- Move: `packages/core/src/` into `server/src/memory/` or adjacent internal runtime folders
- Move: `packages/core/native/` to `server/native/`
- Move: `packages/core/prompts/` to `server/prompts/`
- Modify: `server/package.json`
- Modify: imports from `@muninn/core`
- Modify: `benchmark/locomo/*`
- Modify: scripts under `scripts/`
- Modify: docs with active build paths

This is the largest migration. Keep the first implementation mechanically close to current code. Do not redesign memory internals during this task.

- [ ] **Step 1: Inventory core public imports**

Run:

```bash
rg -n "from '@muninn/core'|import\\('@muninn/core'|packages/core|@muninn/core" server benchmark scripts docs README.md format apple openclaw --glob '!docs/superpowers/**'
```

Expected: output lists all active core references that must move or be rewritten.

- [ ] **Step 2: Move core runtime files**

Run:

```bash
mkdir -p server/src/memory
git mv packages/core/src server/src/memory
git mv packages/core/native server/native
git mv packages/core/prompts server/prompts
```

Expected:

```text
server/src/memory/index.ts exists
server/native/Cargo.toml exists
server/prompts/*.yaml exists
```

- [ ] **Step 3: Update server internal imports**

Replace server imports:

```ts
from '@muninn/core'
```

with relative imports from internal memory entrypoints:

```ts
from '../memory/index.js'
from './memory/index.js'
```

Use the shortest correct relative path from each server file.

Example for `server/src/memory_writer.ts`:

```ts
import { captureTurn, turns } from './memory/index.js';
```

Example for `server/src/ui/app.ts`:

```ts
import {
  validateSettings,
  memories,
  sessions,
  turns,
  isCanonicalProjectIdentity,
} from '../memory/index.js';
```

- [ ] **Step 4: Update moved memory imports**

Inside `server/src/memory/**`, replace package self-imports if any exist:

```ts
from '@muninn/core'
```

with local relative imports.

Replace `@muninn/types` references already handled by Task 1:

```ts
from '@muninn/common'
```

- [ ] **Step 5: Update native build script paths**

Edit `server/package.json` scripts:

```json
"build": "pnpm --filter @muninn/codex build && pnpm --filter @muninn/claude build && pnpm run build:native && tsc",
"build:native": "node ./scripts/build-native.mjs",
"check:native": "cargo check --manifest-path native/Cargo.toml"
```

Move build script:

```bash
mkdir -p server/scripts
git mv packages/core/scripts/build-native.mjs server/scripts/build-native.mjs
```

Edit `server/scripts/build-native.mjs` so paths point to `server/native` and output `server/native/muninn_native.node`.

- [ ] **Step 6: Update benchmark and scripts**

Edit `scripts/run-session-extractor.mjs`:

```js
import {
  getExtractorLlmConfig,
  loadMuninnConfig,
  resolveDatabaseName,
  resolveStorageTarget,
} from '../server/dist/memory/config.js';
import { createNativeTables } from '../server/dist/memory/native.js';
import { __testing as updateTesting } from '../server/dist/memory/extractor/update.js';
```

Edit `scripts/clear-generated-memory.mjs`:

```js
import {
  loadMuninnConfig,
  resolveDatabaseHome,
  resolveDatabaseName,
  resolveStorageTarget,
} from '../server/dist/memory/config.js';
import { createNativeTables } from '../server/dist/memory/native.js';
```

Edit `benchmark/locomo/package.json` dependency:

```json
"@muninn/server": "workspace:*"
```

Replace TypeScript imports in benchmark bridge:

```ts
import type { RecallMode } from '@muninn/server';
```

If `@muninn/server` does not export the needed type, export it from `server/src/index.ts`:

```ts
export type { RecallMode } from './memory/index.js';
```

- [ ] **Step 7: Update macOS and docs paths**

Edit `apple/macos/README.md`:

```text
Resources/Server/
  bin/node
  web/dist/
  server/dist/
  server/native/muninn_native.node
  common/dist/
  node_modules/
```

Edit `format/README.md` active commands:

```sh
cargo check --manifest-path server/native/Cargo.toml
pnpm --filter @muninn/server build
```

- [ ] **Step 8: Remove core package manifest**

Run:

```bash
git rm packages/core/package.json packages/core/tsconfig.json
```

If `packages/core` is empty after moves, remove the directory with:

```bash
rmdir packages/core
```

Expected: no `packages/core/package.json`.

- [ ] **Step 9: Verify Task 8**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/server build
source ~/.zprofile && pnpm --filter @muninn/server test
source ~/.zprofile && cargo check --manifest-path server/native/Cargo.toml
source ~/.zprofile && pnpm --filter @muninn/benchmark-locomo test
```

Expected: all commands exit 0.

- [ ] **Step 10: Commit Task 8**

Run:

```bash
git add server scripts benchmark apple format README.md docs
git commit -m "refactor: fold core runtime into server"
```

Expected: commit succeeds and `rg "@muninn/core|packages/core" . --glob '!docs/superpowers/**'` reports only historical docs that are intentionally left unchanged or no output.

## Task 9: Remove `packages/` Workspace Container

**Files:**
- Modify: `pnpm-workspace.yaml`
- Modify active docs
- Remove empty `packages/` directory

- [ ] **Step 1: Confirm packages directory is empty**

Run:

```bash
find packages -maxdepth 2 -type f -print
```

Expected: no output.

- [ ] **Step 2: Remove packages workspace glob**

Edit `pnpm-workspace.yaml`:

```yaml
packages:
  - 'common'
  - 'web'
  - 'server'
  - 'mcp'
  - 'codex'
  - 'claude'
  - 'benchmark/*'
```

- [ ] **Step 3: Remove empty packages directory**

Run:

```bash
rmdir packages
```

Expected: command exits 0.

- [ ] **Step 4: Update AGENTS module map**

Edit `AGENTS.md` module map:

```md
- `common`
  - Shared Muninn contracts and pure helpers.
- `web`
  - React/Vite browser UI served at `/app/`.
- `server`
  - Backend runtime, HTTP API, memory runtime, and native binding boundary.
- `mcp`
  - MCP adapter layer; talks to server over HTTP.
- `codex`
  - Codex hook/import adapter.
- `claude`
  - Claude hook/import adapter.
- `format/`
  - Rust typed-table, format, and storage implementation.
```

Update dependency direction:

```md
- `web`, `mcp`, `codex`, and `claude` depend on `common`.
- `server` depends on `common`, `codex`, and `claude`.
- `server` owns the memory runtime and native binding boundary to `format/`.
- `mcp` talks to `server`, not directly to memory internals.
```

- [ ] **Step 5: Verify no active packages references**

Run:

```bash
rg -n "packages/(server|core|types|mcp)|@muninn/types|@muninn/core" . --glob '!docs/superpowers/**'
```

Expected: no output outside historical docs deliberately excluded from this migration. If active docs still mention old paths, update them.

- [ ] **Step 6: Full verification**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/common build
source ~/.zprofile && pnpm --filter @muninn/web build
source ~/.zprofile && pnpm --filter @muninn/codex test
source ~/.zprofile && pnpm --filter @muninn/claude test
source ~/.zprofile && pnpm --filter @muninn/server test
source ~/.zprofile && pnpm --filter @muninn/mcp build
source ~/.zprofile && pnpm --filter @muninn/benchmark-locomo test
source ~/.zprofile && swift build --package-path apple/macos
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit Task 9**

Run:

```bash
git add pnpm-workspace.yaml AGENTS.md README.md docs common web server mcp codex claude benchmark apple format
git commit -m "refactor: remove packages workspace container"
```

Expected: commit succeeds.

## Task 10: Final PR Verification

**Files:**
- No source edits expected unless verification exposes failures.

- [ ] **Step 1: Inspect final dependency graph**

Run:

```bash
rg -n "from '@muninn/(server|web|mcp|codex|claude|core|types)'|import\\('@muninn/(server|web|mcp|codex|claude|core|types)'" web common server mcp codex claude benchmark
```

Expected allowed findings:

```text
web imports @muninn/common only
server imports @muninn/common, @muninn/codex, @muninn/claude
mcp imports @muninn/common only
codex imports @muninn/common only
claude imports @muninn/common only
benchmark imports @muninn/common or @muninn/server only if still needed
```

- [ ] **Step 2: Run complete verification suite**

Run:

```bash
source ~/.zprofile && pnpm run build
source ~/.zprofile && pnpm --filter @muninn/server test
source ~/.zprofile && pnpm --filter @muninn/codex test
source ~/.zprofile && pnpm --filter @muninn/claude test
source ~/.zprofile && pnpm --filter @muninn/benchmark-locomo test
source ~/.zprofile && swift build --package-path apple/macos
```

Expected: all commands exit 0.

- [ ] **Step 3: Inspect git status**

Run:

```bash
git status --short --branch
```

Expected: clean worktree on feature branch.

- [ ] **Step 4: Push branch**

Run:

```bash
git push
```

Expected: branch pushes to existing PR.
