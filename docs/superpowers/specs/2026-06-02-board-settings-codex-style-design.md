# Board Settings Codex-Style Redesign

## Goal

Refactor `packages/board` Settings into a Codex-app-style settings page while only exposing existing `muninn.json` configuration. The redesign should improve readability and editing ergonomics without adding new backend capabilities or changing the persisted schema.

The page should support two editing modes:

- `Visual`: structured controls for common fields, with automatic save after each change.
- `JSON`: full `muninn.json` editor, with explicit `Save JSON` button below the editor.

## Scope

In scope:

- Replace the current Settings JSON-only page with a sectioned settings page.
- Keep `#/settings` as the route and `SettingsPage` as the top-level Settings component.
- Parse, edit, validate, and save the current `muninn.json` shape.
- Preserve the current settings API: `GET /api/v1/ui/settings/config` and `PUT /api/v1/ui/settings/config`.
- Keep `validateSettingsJson` as the final save gate, but update it to match the current core config schema.
- Keep demo mode stable when the settings API is unavailable.

Out of scope:

- No import feature.
- No new settings schema.
- No schema key renames.
- No backend migration.
- No Codex-app settings that do not map to Muninn settings.

## Information Architecture

Do not show a large `Settings` page title. The page starts with a lightweight status row and then the editing mode selector.

Top status row:

- Left: current path label, such as `muninn.json` or `~/.muninn/muninn.json`.
- Right: save status text: `Saved`, `Saving...`, `Invalid`, or `Save failed`.

Mode selector:

- A segmented control with `Visual` and `JSON`.
- `Visual` is the default mode.
- The selector is page-level, not per-section.

Visual sections, in order:

1. `Storage`
   - Maps to `storage`.
   - Shows `storage.uri`.
   - Shows `storage.storageOptions` as an editable key/value JSON field.
2. `Providers`
   - Maps to `llm`.
   - Shows existing provider profiles under `llm.*`.
   - Supports editing provider, model, api, apiKey, and baseUrl fields for existing profiles.
   - Supports adding and removing provider profiles only within the existing `llm` object shape.
3. `Extractor`
   - Maps to `extraction`.
   - Shows `extraction.recallMode`.
   - Shows `extraction.defaultImportance`.
   - Shows `extraction.embedding.provider`, `model`, `apiKey`, `baseUrl`, and `dimensions`.
4. `Observer`
   - Maps to `observer`.
   - Shows `observer.name`.
   - Shows `observer.llm`.
   - Shows `observer.maxAttempts`, `anchorThreshold`, `anchorBatchSize`, `contentBudgetChars`, and `activeWindowDays` when present or supported by validation.
5. `Maintenance`
   - Maps to `watchdog`.
   - Shows `watchdog.enabled`.
   - Shows `watchdog.intervalMs`, `compactMinFragments`, and nested extraction maintenance settings supported by current validation.

JSON mode:

- Shows the full current `muninn.json`.
- Uses a large monospace textarea/editor.
- Places `Save JSON` below the editor, left-aligned.
- Shows JSON parse or schema validation errors near the button.

## Visual Design

Use the Codex app references as the visual direction:

- White background.
- Narrow centered content column inside the Board content area.
- Section headings outside cards.
- Rounded list-group cards with thin borders.
- Rows with left-side label and helper text, right-side controls.
- Restrained typography: compact headings, gray helper text, no oversized hero title.
- Controls should feel native to the current Board style: segmented controls, text inputs, selects, toggles, and small action buttons.

Do not turn Settings into a dashboard. Avoid decorative cards, large hero headers, or marketing-style copy.

## Data Model

Add a small settings model layer in `packages/board`:

- Parse raw JSON text into a draft settings object.
- Preserve unknown keys when editing known fields.
- Convert visual edits back into the full JSON object.
- Produce pretty JSON text for JSON mode.

The model should avoid forward-compatibility shims. It should target the current schema only:

- `storage`
- `observer`
- `extraction`
- `llm`
- `watchdog`

`semanticIndex` should not be treated as a current setting because core validation rejects it in favor of `extraction`.

`validateSettingsJson` should be aligned with that current schema during implementation:

- Validate `extraction` and `extraction.embedding`.
- Validate `watchdog.extraction`.
- Stop accepting `semanticIndex` as a current setting.

## Interaction

### Initial Load

1. Load settings through `client.getSettingsConfig()`.
2. Parse JSON.
3. Populate both the visual draft and JSON text.
4. If loading fails, show a static unavailable state. Do not retry in a render loop.

Demo mode behavior:

- If the settings endpoint is unavailable, display a Codex-style unavailable message.
- The page must not flicker.
- A read-only sample JSON preview may be shown only if it helps the demo; it must not imply persistence.

### Visual Mode Autosave

Visual edits save automatically:

1. User changes a field.
2. Update the local draft immediately.
3. Debounce saves for text and number inputs.
4. Toggle/select changes may use the same debounce for consistency.
5. Generate full JSON from the draft.
6. Run `validateSettingsJson`.
7. Save through `client.saveSettingsConfig`.
8. Update status to `Saved`, `Saving...`, `Invalid`, or `Save failed`.

Invalid visual values should be visible near the row that produced them and must not be sent to the server.

### JSON Mode Manual Save

JSON mode never autosaves while the user types.

1. User edits the full JSON text.
2. Mark JSON mode as dirty.
3. Enable the bottom-left `Save JSON` button.
4. On `Save JSON`, parse JSON and run `validateSettingsJson`.
5. If valid, save through `client.saveSettingsConfig`.
6. On success, sync the visual draft from the saved JSON and mark status `Saved`.
7. If invalid, show the error and keep the user in JSON mode.

### Switching Modes

Visual to JSON:

- Generate pretty JSON from the latest draft.
- If a visual autosave is in progress, allow switching but preserve the in-progress status.

JSON to Visual:

- If JSON has no unsaved changes, parse current JSON text and switch.
- If JSON has unsaved changes, require the user to either save JSON or discard JSON edits before switching.
- Do not silently overwrite visual state with invalid JSON.

## Error Handling

- Load failure: show a stable unavailable state.
- Visual field validation failure: show row-level error and block save for that field state.
- JSON parse failure: show JSON-mode error and keep `Save JSON` from writing.
- Server save failure: keep local draft, show `Save failed`, and allow retry by editing again or pressing `Save JSON` in JSON mode.
- Settings API unavailable in demo mode: show static explanation, not repeated retries.

## Components

Keep the implementation focused:

- `SettingsPage`
  - Owns load state, mode state, save status, and draft state.
- `settings-model.ts`
  - Converts raw JSON to draft model and draft model to JSON.
  - Preserves unknown root keys.
- `SettingsSection`
  - Section wrapper for Codex-style section heading and card group.
- `SettingsRow`
  - Label, helper text, right-side control, and optional row error.
- `SettingsModeTabs`
  - Page-level Visual/JSON segmented control.
- `SettingsJsonEditor`
  - JSON textarea and bottom-left `Save JSON` action.

Do not introduce a broad design system. Add only the components needed for Settings.

## Testing

Minimum verification:

- `pnpm --filter @muninn/board exec vite build`
- `pnpm --filter @muninn/types build`
- Browser check `http://127.0.0.1:5173/?demo=1#/settings`
- Confirm demo mode does not flicker.
- Confirm Visual mode renders the five sections in order.
- Confirm JSON tab shows a full JSON editor and bottom-left `Save JSON`.
- Confirm invalid JSON blocks JSON save.
- Confirm switching from dirty JSON to Visual requires save or discard.

If a focused test harness is available for board components, add tests for:

- draft-to-JSON preservation of unknown keys.
- JSON save validation.
- visual autosave debounce behavior.
