# Board Interaction Style

This document defines the interaction and visual style for Muninn Board. It is the reference for Settings, Session, and future Board surfaces.

The goal is a quiet, work-focused interface: dense enough for repeated use, but stable and readable. Prefer Codex app style principles over decorative UI.

Rendered reference:

- Component sheet: [assets/board-component-sheet.html](assets/board-component-sheet.html)
- Screenshot target: [assets/board-component-sheet.png](assets/board-component-sheet.png)

When component standards change, update the component sheet first, then refresh the screenshot so design review can compare a rendered target instead of only reading tokens.

## Principles

- Use visual weight to express meaning, not decoration.
- Keep controls semantically distinct:
  - Tabs select views or categories.
  - Buttons commit actions.
  - Switches show binary state.
  - Filters are compact toolbar controls.
- Keep typography compact and consistent.
- Avoid making unrelated controls all look like the same blue pill.
- Avoid marketing-page patterns: no hero treatment, ornamental cards, decorative gradients, or oversized typography.

## Typography

Codex app source uses these base tokens:

- `text-xs`: `11px`
- `text-sm`: `12px`
- `text-base`: `14px`
- `text-lg`: `16px`
- weights: `400`, `500`, `600`, `700`

Muninn Board should follow Codex's hierarchy, not copy every absolute size. The current Board baseline is `13px`, so the Board typography system is:

| Use | Size | Weight | Notes |
| --- | --- | --- | --- |
| Body text | `13px` | `400` | Default readable content. |
| Row label | `13px` | `600` | Same size as body, stronger weight. |
| Section title | `13px` | `600` | Same treatment as important row labels. |
| Control text | `13px` | `500` | Normal tab/button/control text. |
| Selected control text | `13px` | `600` | Selected tabs and active profile items. |
| Readonly value | `13px` | `400` | Configuration values and row values. |
| Helper or tip text | `12px` | `400` | Low-emphasis explanatory text only. |
| Sidebar compact controls | `12px` | `400-600` | Filters, menu labels, compact popovers. |
| Code or Json editor | `13px` | `400` | Monospace, line height around `1.55-1.6`. |

Rules:

- Do not use `14px` as the normal Settings or Board UI size.
- Do not use `700` for normal interface labels.
- Do not scale font size with viewport width.
- Keep `letter-spacing: 0`.
- Prefer spacing, color, and weight over larger font sizes for hierarchy.

## Color Tokens

Use these as the Board baseline until extracted into CSS variables.

| Token | Value | Use |
| --- | --- | --- |
| `text` | `#1a1c1f` | Main text and body content. |
| `text-muted` | `#5f6062` | Descriptions, idle compact controls. |
| `text-subtle` | `#8f9195` | Time metadata and less important timestamps. |
| `border` | `#ececec` | Card and control borders. |
| `surface` | `#ffffff` | Cards and inputs. |
| `muted-surface` | `#f0f0f0` | Hover rows and selected neutral items. |
| `tab-active-bg` | `#f0f0f0` | Active toolbar tab background. |
| `tab-active-text` | `#1a1c1f` | Active toolbar tab text. |
| `switch-on` | `#339cff` | Enabled switch state. |
| `switch-off` | `#e4e4e7` | Disabled switch state. |
| `primary-button` | `foreground token` | Primary submit or commit button background. In light mode this renders as neutral black. |
| `primary-button-hover` | `foreground / 80%` | Primary submit or commit button hover background. In light mode this renders as dark gray. |
| `primary-button-text` | `dropdown-background token` | Primary submit or commit button text. In light mode this renders as white. |
| `danger` | `#c33838` | Invalid, failed, destructive messaging. |

Rules:

- Tabs use neutral selected styling, following Codex settings toolbar tabs.
- Blue in switches means enabled state.
- Foreground primary buttons mean commit or submit action.
- Do not use blue for submit buttons. Blue is reserved for enabled binary state unless a feature has a stronger explicit reason.
- Time metadata should stay subtle even when row text is body-colored.

## Component Standards

### Toolbar Tabs

Use Codex-style toolbar tabs for mutually exclusive views or categories, such as:

- `Visual / Json`
- `LLM / Embedding`

Style:

- Container: `inline-flex`, `gap: 2px`, no visible shell background.
- Tab height: about `28px`.
- Tab horizontal padding: about `10px`.
- Tab radius: `6px`.
- Idle tab: transparent background, muted text, `13px / 500`.
- Active tab: neutral muted background, main text, `13px / 600`.
- No visible border on individual tabs.

Rules:

- Tabs must not perform submit/save actions.
- Do not use active tab styling for primary buttons.
- Do not use blue for selected tabs; reserve blue for enabled binary state.
- Keep tab labels short and literal.

### Provider Selector

Providers use two left-aligned toolbar tab rows:

- First row selects capability, such as `LLM / Embedding`.
- Second row selects the provider profile name, such as `default`.
- The detail area below shows only key/value rows for the selected provider.

Rules:

- Do not use a left rail for provider profiles unless there are enough profiles to justify persistent side navigation.
- Do not repeat the selected provider name as a header above the key/value list.
- The profile tab interaction should match other toolbar tabs.
- The key/value card should size to its content; avoid large empty fixed-height areas.

### Buttons

Buttons represent actions, not selected state.

#### Primary Button

Use for explicit submit or commit actions:

- `Save`
- `Apply`
- `Import` when it confirms a modal selection.
- icon-only submit buttons, such as Recall search submit.
- future destructive confirmations only when paired with danger color.

Codex app implementation reference:

- Color: `primary` maps to `bg-token-foreground`.
- Hover: `enabled:hover:bg-token-foreground/80`.
- Open state: `data-[state=open]:bg-token-foreground/80`.
- Text: `text-token-dropdown-background`.
- Default radius: `rounded-full`.
- Default size: `px-2 py-0.5 text-sm leading-[18px]`.

Board style:

- Height: about `30-34px`, depending on local density.
- Padding: `0 10-12px`.
- Radius: `6px`. Codex app's shared button primitive often uses pill primary buttons, but Muninn Board keeps rounded-rectangle buttons so actions align with its Settings rows, tables, and compact control surfaces.
- Background: foreground token, with static fallback `#111111`.
- Hover background: foreground token at `80%`, with static fallback around `#333333`.
- Active background: foreground token at full strength, with static fallback `#000000`.
- Text: dropdown background token, with static fallback `#ffffff`.
- Font: `13px / 500`.

Rules:

- Use one primary button per action cluster.
- Do not use primary styling for navigation, tabs, filters, row expansion, or passive import entry points.
- Icon-only submit buttons, such as composer or search submit, are the exception to Muninn's rounded-rectangle button shape: use a circular foreground button with an arrow icon, matching Codex's composer submit affordance.
- Icon-only submit buttons should use the same foreground primary color and `foreground / 80%` hover state, but remain visually small.

#### Secondary Button

Use for lower-emphasis actions that still perform an operation:

- `Reset`
- `Copy`
- `Import` when it opens an import flow rather than confirming it.
- `Import sessions` empty-state entry points.

Style:

- White background.
- `#ececec` border.
- Text: `#3f4248`.
- Same size as primary button.

#### Ghost Button

Use for low-emphasis or contextual actions:

- `Cancel`
- toolbar icon buttons.
- optional row actions.

Style:

- Transparent background.
- Muted text.
- Hover uses muted surface.

Rules:

- Do not make primary action buttons look like active segmented tabs.
- Do not use white text on active tabs.
- Icon-only buttons should use familiar icons and a tooltip or accessible label.
- Keep optional row actions ghost/neutral. Do not turn row-level import/delete icons into filled primary buttons.

### Switches And Binary Pills

Use switches for binary state only.

Style:

- Width: `42px`.
- Height: `24px`.
- Off background: `#e4e4e7`.
- On background: `#339cff`.
- Knob: white, `18px`.
- Knob inset: `3px`.

Rules:

- Switch blue only means enabled.
- Switches should not be used for view switching.
- Keep switch labels in the row copy, not inside the switch.

### Compact Filters

Use compact filter pills in sidebars and dense toolbars, such as Session filters:

- `Agents: All`
- `Last 7 days`

Style:

- Height: `30px`.
- Font: `12px`.
- Border: `#ececec`.
- Background: white.
- Text: muted.
- Radius: `6px`.

Rules:

- Compact filters may use `12px` because they live in constrained sidebar/toolbars.
- Main content controls should stay at the `13px` baseline.
- A filtered or open state may gain stronger text or a neutral selected surface, but should not look like a primary action.

## Settings Layout

Settings uses the Board baseline layout:

- Content max width: about `900px`.
- Page padding: about `38px 32px 56px`.
- Section gap: about `34px`.
- Section title to card gap: about `16px`.
- Visual settings should show effective runtime values, not only fields explicitly present in `muninn.json`.
- When a config value is defaulted by runtime resolution, show the resolved default value instead of hiding the row.
- Keep row descriptions stable and human-readable; do not switch descriptions to `Default ...` just because the value came from runtime defaults.
- Row min height: about `72px`.
- Row padding: about `15px 18px`.
- Row grid: copy on the left, value/control on the right.

Visual mode:

- Read-only.
- Show the read-only tip below the mode tabs.
- Use row/card display for configuration values.

Json mode:

- Editable.
- No read-only tip.
- Uses explicit `Save`.
- Editor width must match Visual content width.
- Mode tabs to editor gap: about `28px`.
- Editor to Save gap: about `24px`.

## Session Tree

Project and session rows are navigation hierarchy. Turn rows are body content.

Rules:

- Project row may use muted text.
- Session row may use stronger text and medium weight.
- Turn title should use body text color and normal body weight.
- Turn time remains subtle.

Recommended styling:

- Turn title: `#1a1c1f`, `13px / 400`.
- Turn time: `#8f9195`, `13px / 400`.

## Scrollbars

Use weak scrollbars until interaction:

- Default thumb transparent or subtle.
- Hover shows a clearer thumb.
- Active thumb is stronger.
- Page-level scrollbars should sit on the main content edge when possible.
- Internal editors may keep their own scroll when content is long.

## Implementation Checklist

Before shipping Board UI changes:

- Confirm control semantics: tab, button, switch, or filter.
- Confirm text sizes follow the `13px` baseline, with `12px` only for helper or compact sidebar controls.
- Confirm active tabs use neutral selected styling, not blue selected styling.
- Confirm submit actions use foreground-token primary styling, while switches keep blue enabled styling.
- Confirm Visual and Json widths do not shift when switching modes.
- Confirm no text overlaps or changes layout unexpectedly.
- Run:

```sh
source ~/.zprofile && pnpm --filter @muninn/web build
```
