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

Pane titles should not be shown inside the content canvas. The session title at the top-left is the only visible page heading, and the three mode icons at the top-right explain the current layout state.

There should be no horizontal separator under the title row. The content should feel like one continuous canvas.

## View Modes, Resizing, And Transitions

The top-right of the Session content canvas has three icon controls:

- Observation only.
- Split view.
- Conversation only.

These controls are mutually exclusive. The default mode is Split view.

Icon treatment:

- The three mode icons float at the top-right of the content canvas.
- The buttons have no default outer border or heavy toolbar container.
- The active mode uses a subtle gray background.
- The internal glyphs share one visual style: a small pane outline with an internal divider positioned left, center, or right.
- The left and right glyph divider positions should be offset enough to distinguish Observation-only and Conversation-only at a glance.

Split view resize behavior:

- The divider is a slim vertical line between the two panes.
- The divider runs from the top edge to the bottom edge of the content canvas.
- Hovering over the divider changes the line treatment and cursor to make resizing discoverable.
- Dragging changes the Observation pane width; Conversation fills the remaining space.
- Observation minimum width should keep accordion headers readable, around `320px`.
- Conversation minimum width should keep chat bubbles usable, around `520px`.
- The last chosen split width may be kept in local UI state; persistence is optional for this iteration.

Single-pane behavior:

- Observation-only mode hides Conversation and the divider.
- Conversation-only mode hides Observation and the divider.
- Returning to Split restores the previous split width when available.
- The mode icons remain visible in all modes.

Transitions:

- Mode changes should use short, restrained transitions similar to Codex App.
- Pane width/opacity should transition quickly, around `140-180ms`.
- The active icon background should transition around `120ms`.
- Divider movement during drag should be immediate, not animated.
- Respect reduced-motion preferences by disabling non-essential transitions.
- The animation should clarify continuity, not call attention to itself.

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
- Observation-only mode hides Conversation and divider.
- Conversation-only mode hides Observation and divider.
- Returning to Split restores the previous split width when available.
- Mode icon active state updates consistently.
- Markdown in observation content renders lists, code, tables, and links without layout overflow.
- No-snapshot sessions still fall back to current turn prompt navigation.

Manual verification should use the Board page at a local sidecar URL and confirm:

- Session click shows collapsed observations plus full conversation.
- Segment click expands the correct observation.
- Conversation scroll target matches the observation's first ref.
- Divider drag feels lightweight and does not resize below usable widths.
- Three floating mode icons switch Observation-only, Split, and Conversation-only modes.
- The Split divider runs full height and has no extra buttons.
- Mode transitions feel restrained and do not disrupt reading.
- Pane labels `Observation` and `Conversation` are not shown as content headings.
- The accordion feels visually lighter than the earlier table-like mockup.
