# Board Session Observation Split Design

## Scope

Add an Observation reading pane to the Board Session content page. The page should show a split view where Observation content and Conversation content are visible together. This is a UI/navigation change for the Session page; it does not change the extractor prompt, schema, import flow, or observation generation.

## Current Context

The Session page currently has three relevant layers:

- The left Session tree shows project -> session -> segment navigation.
- Segment nodes are currently derived from the latest session snapshot extraction blocks when available, with turn prompt fallback.
- The content area currently focuses on Conversation rendering through `ChatView`.

The new page should reuse session snapshot extraction blocks as the Observation source because those blocks already align with the third-level Session tree segments. `session_observation` table rows should remain a future alignment target, not the data source for this UI iteration.

## Layout

The Session content area becomes a two-pane split:

- Left pane: Observation.
- Right pane: Conversation.

Recommended width:

- Observation: about 34-38% of the content area.
- Conversation: remaining width.

The left placement is intentional: the user enters through a summary/observation navigation model, then checks the supporting conversation on the right. This keeps the extracted memory as the primary reading object while preserving direct access to source evidence.

## Resizing And Collapse

The divider between Observation and Conversation should be draggable.

Resize behavior:

- The divider is a slim vertical line between the two panes.
- Hovering over the divider changes the line treatment and cursor to make resizing discoverable.
- Dragging changes the Observation pane width; Conversation fills the remaining space.
- Observation minimum width should keep accordion headers readable, around `320px`.
- Conversation minimum width should keep chat bubbles usable, around `520px`.
- The last chosen split width may be kept in local UI state; persistence is optional for this iteration.

Collapse behavior:

- Observation can collapse, leaving Conversation full width.
- Conversation can collapse, leaving Observation full width.
- Both panes cannot be collapsed at the same time.
- Collapsed state should leave a narrow restore affordance on the collapsed side instead of removing all controls.
- The restore affordance should sit on or near the divider line, not as a heavy toolbar button.
- Dragging is disabled while either pane is collapsed; restoring returns to the previous split width when available.

Recommended controls:

- Observation header has a small collapse icon for hiding Observation.
- Conversation header has a small collapse icon for hiding Conversation.
- When Observation is collapsed, a slim rail on the left side of the content area restores it.
- When Conversation is collapsed, a slim rail on the right side restores it.

This keeps the default split readable while still allowing focused reading of either the extracted memory document or the raw conversation.

## Session Selection Behavior

When the user clicks a second-level session node:

- The Conversation pane shows the whole session.
- The Observation pane shows the session summary and all snapshot extraction blocks.
- All observation items are collapsed by default.
- The user can manually expand and collapse observation items.

This means second-level selection is a session overview state, not a jump to one specific observation.

## Segment Selection Behavior

When the user clicks a third-level segment node:

- The Observation pane scrolls to the corresponding extraction block.
- That observation item expands automatically.
- That observation item is highlighted.
- The Conversation pane scrolls to the first referenced turn for that extraction block.

The third-level tree remains a fast navigation control. It should not replace the Observation pane itself.

## Observation Interaction

Use the Soft Accordion design:

- Each extraction block is one accordion item.
- The item header shows the extraction `### Title`.
- The item body renders the extraction Markdown.
- Items are visually light: no table-like borders, no dense setting-row layout.
- The selected or expanded item may use a soft gray background and a chevron.
- Multiple items may be expanded at the same time.

The default collapsed item should be compact enough for scanning, but the expanded content should read like a Markdown document, not a form or table.

## Markdown Rendering

Each extraction block should render as a Markdown document fragment:

- `### Title` is used for the accordion header and should not need to repeat as a large heading inside the expanded body.
- `### Summary` renders as normal Markdown content.
- `### Content` renders as normal Markdown content when present.
- Lists, code spans, code blocks, tables, and links should use the same Markdown rendering conventions as the Conversation pane.

The rendered body should not overflow the pane. Long code blocks or tables should scroll within their own horizontal boundary rather than stretching the layout.

## Data Flow

The Session turns API should continue returning `turns` for Conversation.

For Observation, it should expose enough snapshot-derived information for the UI to render and navigate without reparsing large Markdown on the client in ad hoc ways. A practical shape is:

- `memoryId`: the first referenced turn id, preserving current segment navigation behavior.
- `title`: extraction title for tree and accordion header.
- `createdAt`: timestamp of the first referenced turn.
- `markdown`: the extraction body to render in the Observation pane.
- `refs`: referenced turn ids from the extraction metadata.

The current lightweight `segments` can be extended or paired with a new `observations` field. The important constraint is that the third-level tree item and Observation accordion item must share a stable identity.

## Error And Fallback Behavior

If a session has no snapshot extraction blocks:

- The Observation pane shows an empty-state message.
- The Session tree keeps using the existing turn prompt fallback.
- Conversation behavior remains unchanged.

If an extraction block has a title but no content:

- Render the header.
- Show available summary content if present.
- Otherwise show a lightweight empty body.

If a third-level segment points to a turn ref that is not loaded yet:

- The app should load more conversation turns as needed when possible.
- If it cannot resolve the turn, it should still expand the Observation item and avoid a broken navigation state.

## Component Boundaries

Recommended components:

- `SessionContentSplit`: owns the Observation/Conversation layout.
- `ObservationPane`: renders session summary and observation accordion list.
- `ObservationAccordionItem`: renders one snapshot extraction block.
- `ChatView`: keeps rendering conversation and timeline blocks.

`ChatView` should not become responsible for observation rendering. The split container coordinates selection and scroll targets.

## Testing

Add or update focused tests for:

- Snapshot extraction parsing returns title, markdown, refs, and first-turn jump target.
- Clicking a second-level session opens full session content with all observations collapsed.
- Clicking a third-level segment expands the matching observation and targets the first referenced turn.
- Dragging the split divider updates pane width within min-width constraints.
- Collapsing Observation expands Conversation and leaves a restore affordance.
- Collapsing Conversation expands Observation and leaves a restore affordance.
- Markdown in observation content renders lists, code, tables, and links without layout overflow.
- No-snapshot sessions still fall back to current turn prompt navigation.

Manual verification should use the Board page at a local sidecar URL and confirm:

- Session click shows collapsed observations plus full conversation.
- Segment click expands the correct observation.
- Conversation scroll target matches the observation's first ref.
- Divider drag feels lightweight and does not resize below usable widths.
- Each pane can be collapsed and restored without losing the selected observation.
- The accordion feels visually lighter than the earlier table-like mockup.
