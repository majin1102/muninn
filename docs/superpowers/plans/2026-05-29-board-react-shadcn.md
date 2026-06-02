# Board React Shadcn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `packages/board` as a React/Vite shadcn-style memory console with a top-level sidebar, project-organized sessions, and a chat-only detail view.

**Architecture:** Keep the existing sidecar UI APIs and project sessions into a frontend tree grouped by project name. Replace the string-template DOM renderer with React components and local shadcn-style primitives copied into the board package. Remove Snapshots/Observing from the Board UI.

**Tech Stack:** Vite, React, TypeScript, lucide-react, react-markdown, remark-gfm, local CSS variables matching shadcn tokens.

---

### Task 1: Build Tooling

**Files:**
- Modify: `packages/board/package.json`
- Modify: `packages/board/tsconfig.json`
- Create: `packages/board/vite.config.ts`
- Modify: `packages/board/src/index.html`

- [ ] Add React/Vite dependencies and change `build` to `vite build && tsc -p tsconfig.server.json && mkdir -p dist/assets && cp -R src/assets/. dist/assets/`.
- [ ] Configure TypeScript for JSX with `jsx: react-jsx`.
- [ ] Configure Vite to emit static assets into `dist`.
- [ ] Change `index.html` to load `/src/main.tsx`.
- [ ] Run `source ~/.zprofile && pnpm install`.
- [ ] Run `source ~/.zprofile && pnpm --filter @muninn/board build`.
- [ ] Commit with `chore: add react board build`.

### Task 2: Shared Data Layer

**Files:**
- Create: `packages/board/src/lib/api.ts`
- Create: `packages/board/src/lib/transcript.ts`
- Create: `packages/board/src/lib/utils.ts`
- Modify: `packages/board/src/demo/data.ts`

- [ ] Move the API types, `resolveApiBase`, `fetchJson`, demo/live loading helpers, formatting helpers, and route-safe helpers out of the old renderer into focused modules.
- [ ] Add `ProjectNode`, `ProjectSessionNode`, and `ProjectTurnNode` frontend projection types.
- [ ] Build projects by fetching agents, then sessions per agent, and grouping sessions by `displaySessionId` project key. Keep agent as metadata on sessions and turns.
- [ ] Preserve demo mode via `?demo=1`.
- [ ] Parse transcripts from `## User`/`## Assistant` and from turn sections `## Prompt`/`## Response`; fallback to full Markdown message when no transcript sections exist.
- [ ] Run `source ~/.zprofile && pnpm --filter @muninn/board build`.
- [ ] Commit with `feat: add board data projection`.

### Task 3: Shadcn Primitives And App Shell

**Files:**
- Create: `packages/board/src/components/ui/button.tsx`
- Create: `packages/board/src/components/ui/avatar.tsx`
- Create: `packages/board/src/components/ui/collapsible.tsx`
- Create: `packages/board/src/components/ui/scroll-area.tsx`
- Create: `packages/board/src/components/App.tsx`
- Replace: `packages/board/src/main.tsx`
- Replace: `packages/board/src/styles.css`

- [ ] Add local shadcn-style primitives with accessible defaults and CSS class contracts.
- [ ] Build a full-height left sidebar with logo + `Muninn`, top-level items `Search`, `LLM Wiki`, `Session`, and `Settings`.
- [ ] Remove the old topbar mode dropdown and Snapshots route.
- [ ] Keep topbar actions for data mode, version, GitHub, and settings access inside the new shadcn-style header region.
- [ ] Run `source ~/.zprofile && pnpm --filter @muninn/board build`.
- [ ] Commit with `feat: rebuild board shell`.

### Task 4: Project Sessions And Chat

**Files:**
- Create: `packages/board/src/components/SessionTree.tsx`
- Create: `packages/board/src/components/ChatView.tsx`
- Create: `packages/board/src/components/SettingsDialog.tsx`
- Modify: `packages/board/src/components/App.tsx`

- [ ] Render Session as Project -> Session -> Turn using collapsible groups.
- [ ] Opening a turn loads the memory document and shows only the chat interaction, no document title/header/breadcrumb.
- [ ] User messages align left and Agent messages align right.
- [ ] Markdown inside bubbles is rendered with `react-markdown` and `remark-gfm`.
- [ ] Search and LLM Wiki render empty-state panels; Settings opens the existing settings editor.
- [ ] Run `source ~/.zprofile && pnpm --filter @muninn/board build`.
- [ ] Browser-check `http://localhost:8080/board/?demo=1#/session`.
- [ ] Commit with `feat: add project session chat view`.

### Task 5: Final Verification

**Files:**
- Verify all touched files.

- [ ] Run `source ~/.zprofile && pnpm --filter @muninn/board build`.
- [ ] Run `source ~/.zprofile && pnpm --filter @muninn/sidecar build`.
- [ ] Open `http://localhost:8080/board/?demo=1#/session` and verify logo/sidebar, no Snapshots dropdown, Project -> Session -> Turn, and chat-only detail.
- [ ] Run `git status --short --branch`.
