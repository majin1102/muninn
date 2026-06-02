# Muninn Board Shadcn Refresh Design

## Summary

Refresh the existing Muninn Board web UI in place instead of creating a new module.

The implementation should keep the current `packages/board` module, current Board routes, current topbar controls, and current session tree behavior. The visual language should move toward the clean shadcn dashboard preview style: white and neutral gray surfaces, thin borders, compact controls, low decoration, and clear application-shell structure.

The visible brand should be only the temporary crow logo plus `Muninn`. Do not introduce a secondary product name such as Console, Hub, Dashboard, or Workspace.

## Goals

- Keep `packages/board` as the implementation target.
- Keep the existing Board topbar content and actions.
- Restyle the UI to match the shadcn dashboard preview direction.
- Keep the current Session left-pane model: Agent as the first-level tree item, Session as the second-level item.
- Keep the current resizeable two-pane Board workspace unless a narrow visual adjustment is needed.
- Change selected session/turn detail display so Transcript uses a chat-style layout.
- Use the temporary crow PNG as the working logo asset.

## Non-Goals

- Do not create a new `packages/console`, `packages/hub`, or separate app shell.
- Do not rename `@muninn/board`.
- Do not redesign the current topbar content or remove its existing controls.
- Do not turn the Board into a metric dashboard.
- Do not make LLM Wiki a complete feature in this pass.
- Do not replace existing sidecar UI APIs as part of the visual refresh.

## Brand

The upper-left brand area should contain:

- The temporary crow logo PNG.
- The text `Muninn`.

It should not contain a boxed logo background, extra subtitle, or secondary product name.

The current HTML document title can remain `Muninn Board` for now. User-facing in-app brand text should prefer `Muninn`.

## Layout

The existing Board structure should be preserved at a product level:

- Topbar across the top.
- Left pane for mode selection and tree/list navigation.
- Resize handle between the left pane and detail pane.
- Right pane for the selected document/detail view.

The visual treatment should be updated to feel closer to shadcn dashboard blocks:

- Page background: neutral gray.
- Panels: white or near-white.
- Borders: thin zinc/slate gray.
- Shadows: minimal or none.
- Radius: restrained, roughly 8 to 14 px depending on component size.
- Typography: compact, clear, no oversized hero styling.

## Topbar

The topbar should keep the current Board content and actions:

- Brand area.
- Data mode toggle: `Live`, `Tree`, `Card`.
- `Settings` action.
- Version link.
- GitHub link.

Only the visual styling should change. The topbar should not become a new breadcrumb/search/user-control header like the earlier mockups.

## Left Pane

The left pane should keep the current mode switcher behavior:

- `Session`.
- `Snapshots` or the current observation/snapshot label.

For `Session`, the left pane should preserve the existing hierarchy:

- Agent is the first-level item.
- Session is the second-level item.
- Turns remain nested under the selected/expanded session when available.

The styling should become more shadcn-like:

- Tree rows use compact row height, subtle hover background, and rounded active states.
- Agent rows visually read as group headers.
- Session rows are nested but still easy to scan.
- Timestamp/meta text remains aligned and muted.

## Right Pane

The right pane should still show the selected memory/document detail.

For selected session turn documents, the detail area should support a Transcript presentation:

- User messages align left.
- Agent messages align right.
- User bubbles use a white surface.
- Agent bubbles use a subtle muted gray surface.
- Each message can show role, time, and turn id when available.
- Message bubbles should remain readable on desktop and mobile widths.

For selected non-transcript documents or markdown memory documents, the existing markdown renderer can remain the baseline. The implementation may add a detection layer only if current payloads can safely distinguish transcript-like content from regular markdown documents.

## Tabs

The longer-term session detail model is:

- `Transcript`.
- `Extractions`.
- `Artifacts`.

For this pass, tabs should only be introduced if the existing Board data model can support them cleanly. If the current sidecar only returns a single markdown document for a selected memory, the implementation should avoid fake tabs and instead restyle the current detail shell first.

## Search And LLM Wiki

The current Board implementation does not yet expose a full Search or LLM Wiki page in the confirmed scope.

If navigation placeholders are added later, they should not disrupt the current Session/Snapshot workflow. This design pass should focus on refreshing the existing Board UI and Transcript presentation first.

## Logo Asset

Use the temporary PNG created during brainstorming as the working logo.

The implementation should copy it into a committed Board asset path, likely under `packages/board/src/assets/` or another existing static asset convention in the package.

The logo should render without a surrounding square frame in the brand area.

## Error And Empty States

Existing loading, empty, and error states should remain functionally equivalent:

- Loading session tree.
- No session memories.
- No selected memory.
- Loading document.
- Document error.
- Settings loading/save errors.

These states should be restyled to match the new neutral, compact visual system.

## Testing And Verification

Implementation should be verified with:

- `pnpm --filter @muninn/board build`.
- Any existing Board or core tests that cover changed behavior.
- Browser verification against the Board route.
- Desktop and mobile-width screenshots.
- Manual checks for topbar controls, mode switching, left-pane tree expansion, resizing, settings modal, and selected document rendering.

## Open Questions

- Whether Transcript chat rendering can be derived from current document payloads without adding a new sidecar UI API.
- Whether `Snapshots` should remain the mode label or be renamed later. This design does not rename it.
