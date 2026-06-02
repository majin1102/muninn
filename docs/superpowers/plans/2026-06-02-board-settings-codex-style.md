# Board Settings Codex-Style Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Muninn Board Settings as a Codex-style page with Visual autosave and JSON manual save for the existing `muninn.json` schema.

**Architecture:** Add a pure settings model layer that parses, preserves, edits, validates, and stringifies current `muninn.json`. Keep `SettingsPage` as the route-level container, split presentational controls into small local components, and keep persistence through the existing Board settings API. Visual mode saves after debounced field edits; JSON mode writes only through an explicit bottom-left `Save JSON` button.

**Tech Stack:** React 19, TypeScript, Vite, existing Board CSS, existing Hono settings API, existing `validateSettingsJson`.

---

## File Map

- Create `packages/board/src/lib/settings-model.ts`
  - Owns `MuninnSettingsDraft`, parse/stringify helpers, path-level visual updates, JSON parse validation, and default sample config.
- Verify `packages/board/src/lib/settings-model.ts`
  - Compile the model file to `/private/tmp` and run Node assertions against the compiled output.
- Modify `packages/board/src/server/settings.ts`
  - Align validation with current core schema: `extraction`, `extraction.embedding`, `watchdog.extraction`, and reject legacy `semanticIndex`.
- Modify `packages/board/src/components/SettingsDialog.tsx`
  - Replace JSON-only page with Visual/JSON modes, autosave state, manual JSON save, and switch guard.
- Modify `packages/board/src/styles.css`
  - Add Codex-style settings page layout, segmented tabs, settings cards, rows, controls, status, JSON editor, and unavailable state.

## Task 1: Settings Model

**Files:**
- Create: `packages/board/src/lib/settings-model.ts`

- [ ] **Step 1: Verify the model is absent**

Run:

```bash
test ! -f packages/board/src/lib/settings-model.ts
```

Expected: PASS before implementation.

- [ ] **Step 2: Implement the model**

Create `packages/board/src/lib/settings-model.ts`:

```ts
export type JsonObject = Record<string, unknown>;
export type SettingPath = [string, ...string[]];

export type MuninnSettingsDraft = {
  root: JsonObject;
  sourceText: string;
};

export type ParseSettingsJsonResult =
  | { ok: true; draft: MuninnSettingsDraft }
  | { ok: false; errorMessage: string };

export const SAMPLE_SETTINGS: JsonObject = {
  storage: {
    uri: 'file:///Users/Nathan/.muninn',
  },
  observer: {
    name: 'default-observer',
    llm: 'default_observer_llm',
    maxAttempts: 3,
    activeWindowDays: 30,
  },
  extraction: {
    recallMode: 'hybrid',
    defaultImportance: 0.7,
    embedding: {
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
    },
  },
  llm: {
    default_observer_llm: {
      provider: 'openai',
      model: 'gpt-4.1',
    },
  },
  watchdog: {
    enabled: true,
    intervalMs: 60000,
    compactMinFragments: 24,
    extraction: {
      targetPartitionSize: 256,
      optimizeMergeCount: 4,
    },
  },
};

export function parseSettingsDraft(text: string): MuninnSettingsDraft {
  const parsed = JSON.parse(text) as unknown;
  if (!isJsonObject(parsed)) {
    throw new Error('muninn.json must be a JSON object.');
  }
  return {
    root: parsed,
    sourceText: prettyJson(parsed),
  };
}

export function parseSettingsJsonText(text: string): ParseSettingsJsonResult {
  try {
    return { ok: true, draft: parseSettingsDraft(text) };
  } catch (error) {
    return {
      ok: false,
      errorMessage: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function sampleSettingsDraft(): MuninnSettingsDraft {
  return parseSettingsDraft(prettyJson(SAMPLE_SETTINGS));
}

export function settingsDraftToJson(draft: MuninnSettingsDraft): string {
  return prettyJson(draft.root);
}

export function getSettingValue(draft: MuninnSettingsDraft, path: SettingPath): unknown {
  let current: unknown = draft.root;
  for (const segment of path) {
    if (!isJsonObject(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

export function getSettingString(draft: MuninnSettingsDraft, path: SettingPath): string {
  const value = getSettingValue(draft, path);
  return typeof value === 'string' ? value : '';
}

export function getSettingNumber(draft: MuninnSettingsDraft, path: SettingPath): string {
  const value = getSettingValue(draft, path);
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

export function getSettingBoolean(draft: MuninnSettingsDraft, path: SettingPath): boolean {
  return getSettingValue(draft, path) === true;
}

export function getSettingObjectText(draft: MuninnSettingsDraft, path: SettingPath): string {
  const value = getSettingValue(draft, path);
  return isJsonObject(value) ? prettyJson(value) : '{}';
}

export function updateSettingPath(draft: MuninnSettingsDraft, path: SettingPath, value: unknown): MuninnSettingsDraft {
  const root = cloneJsonObject(draft.root);
  let current: JsonObject = root;
  for (const segment of path.slice(0, -1)) {
    const existing = current[segment];
    const next = isJsonObject(existing) ? cloneJsonObject(existing) : {};
    current[segment] = next;
    current = next;
  }
  current[path[path.length - 1]] = value;
  return {
    root,
    sourceText: prettyJson(root),
  };
}

export function parseOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function parseOptionalInteger(value: string): number | undefined {
  const parsed = parseOptionalNumber(value);
  if (parsed === undefined) {
    return undefined;
  }
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

export function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
```

- [ ] **Step 3: Compile the model for isolated assertions**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/board exec tsc src/lib/settings-model.ts --target ES2022 --module ES2022 --moduleResolution Bundler --outDir /private/tmp/muninn-settings-model-check
```

Expected: PASS and `/private/tmp/muninn-settings-model-check/settings-model.js` exists.

- [ ] **Step 4: Run model assertions**

Run:

```bash
node --input-type=module -e "
  import assert from 'node:assert/strict';
  const model = await import('/private/tmp/muninn-settings-model-check/settings-model.js');
  const draft = model.parseSettingsDraft(JSON.stringify({ storage: { uri: 'file:///old' }, customRoot: { keep: true } }));
  const updated = model.updateSettingPath(draft, ['storage', 'uri'], 'file:///new');
  const parsed = JSON.parse(model.settingsDraftToJson(updated));
  assert.equal(parsed.storage.uri, 'file:///new');
  assert.deepEqual(parsed.customRoot, { keep: true });
  const ok = model.parseSettingsJsonText('{\"observer\":{\"name\":\"default\",\"llm\":\"main\"}}');
  assert.equal(ok.ok, true);
  const bad = model.parseSettingsJsonText('{\"observer\":');
  assert.equal(bad.ok, false);
  assert.match(bad.errorMessage, /invalid JSON/i);
"
```

Expected: command exits 0.

## Task 2: Align Settings Validation

**Files:**
- Modify: `packages/board/src/server/settings.ts`

- [ ] **Step 1: Replace legacy semantic index validation**

Update `validateSettingsJson` so it validates current `extraction` and rejects `semanticIndex`:

```ts
  if (root.semanticIndex !== undefined) {
    throw new Error('semanticIndex is no longer supported; use extraction instead.');
  }

  const extraction = root.extraction;
  if (extraction !== undefined) {
    if (!extraction || typeof extraction !== 'object' || Array.isArray(extraction)) {
      throw new Error('extraction must be an object if provided.');
    }

    const config = extraction as Record<string, unknown>;
    const embedding = config.embedding;
    if (embedding !== undefined) {
      if (!embedding || typeof embedding !== 'object' || Array.isArray(embedding)) {
        throw new Error('extraction.embedding must be an object if provided.');
      }

      const embeddingConfig = embedding as Record<string, unknown>;
      for (const key of ['provider', 'model', 'apiKey', 'baseUrl']) {
        const value = embeddingConfig[key];
        if (value !== undefined && typeof value !== 'string') {
          throw new Error(`extraction.embedding.${key} must be a string.`);
        }
      }
      if (
        embeddingConfig.dimensions !== undefined &&
        (!Number.isInteger(embeddingConfig.dimensions) || (embeddingConfig.dimensions as number) <= 0)
      ) {
        throw new Error('extraction.embedding.dimensions must be a positive integer.');
      }
    }

    if (
      config.defaultImportance !== undefined &&
      (typeof config.defaultImportance !== 'number' || Number.isNaN(config.defaultImportance))
    ) {
      throw new Error('extraction.defaultImportance must be a number.');
    }

    if (config.recallMode !== undefined && !['vector', 'fts', 'hybrid'].includes(String(config.recallMode))) {
      throw new Error('extraction.recallMode must be one of: vector, fts, hybrid.');
    }
  }
```

- [ ] **Step 2: Update watchdog nested validation**

Inside watchdog validation, validate `watchdog.extraction` instead of `watchdog.semanticIndex`:

```ts
    const extractionConfig = config.extraction;
    if (extractionConfig !== undefined) {
      if (
        !extractionConfig ||
        typeof extractionConfig !== 'object' ||
        Array.isArray(extractionConfig)
      ) {
        throw new Error('watchdog.extraction must be an object if provided.');
      }

      const nested = extractionConfig as Record<string, unknown>;
      for (const key of ['targetPartitionSize', 'optimizeMergeCount']) {
        const value = nested[key];
        if (value !== undefined && (!Number.isInteger(value) || (value as number) <= 0)) {
          throw new Error(`watchdog.extraction.${key} must be a positive integer.`);
        }
      }
    }
```

- [ ] **Step 3: Verify validation through build**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/board exec vite build
```

Expected: PASS.

## Task 3: Settings UI and Interaction

**Files:**
- Modify: `packages/board/src/components/SettingsDialog.tsx`
- Modify: `packages/board/src/styles.css`

- [ ] **Step 1: Replace JSON-only SettingsPage with mode-based SettingsPage**

Implement `SettingsPage` with:

- `mode: 'visual' | 'json'`
- `draft: MuninnSettingsDraft | null`
- `jsonText: string`
- `jsonDirty: boolean`
- `status: 'idle' | 'loading' | 'saved' | 'saving' | 'invalid' | 'failed' | 'unavailable'`
- `statusMessage: string | null`

Use imports:

```ts
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getSettingBoolean,
  getSettingNumber,
  getSettingObjectText,
  getSettingString,
  parseOptionalInteger,
  parseOptionalNumber,
  parseSettingsDraft,
  parseSettingsJsonText,
  sampleSettingsDraft,
  settingsDraftToJson,
  updateSettingPath,
  type MuninnSettingsDraft,
  type SettingPath,
} from '../lib/settings-model.js';
```

- [ ] **Step 2: Add load behavior**

On mount/client change:

```ts
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setStatusMessage(null);
    client.getSettingsConfig()
      .then((response) => {
        if (cancelled) return;
        const nextDraft = parseSettingsDraft(response.content);
        setPathLabel(response.pathLabel);
        setDraft(nextDraft);
        setJsonText(settingsDraftToJson(nextDraft));
        setJsonDirty(false);
        setStatus('saved');
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        const fallback = sampleSettingsDraft();
        setDraft(fallback);
        setJsonText(settingsDraftToJson(fallback));
        setJsonDirty(false);
        setStatus('unavailable');
        setStatusMessage(asErrorMessage(loadError));
      });
    return () => {
      cancelled = true;
    };
  }, [client]);
```

- [ ] **Step 3: Add visual autosave**

Use a debounced save ref:

```ts
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function scheduleVisualSave(nextDraft: MuninnSettingsDraft) {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    setStatus('saving');
    setStatusMessage(null);
    saveTimerRef.current = setTimeout(() => {
      const nextJson = settingsDraftToJson(nextDraft);
      try {
        validateSettingsJson(nextJson);
      } catch (validationError) {
        setStatus('invalid');
        setStatusMessage(asErrorMessage(validationError));
        return;
      }
      client.saveSettingsConfig(nextJson)
        .then((response) => {
          const savedDraft = parseSettingsDraft(response.content);
          setPathLabel(response.pathLabel);
          setDraft(savedDraft);
          setJsonText(settingsDraftToJson(savedDraft));
          setJsonDirty(false);
          setStatus('saved');
        })
        .catch((saveError: unknown) => {
          setStatus('failed');
          setStatusMessage(asErrorMessage(saveError));
        });
    }, 600);
  }
```

- [ ] **Step 4: Add visual field update helper**

```ts
  function updateVisual(path: SettingPath, value: unknown) {
    if (!draft) return;
    const nextDraft = updateSettingPath(draft, path, value);
    setDraft(nextDraft);
    if (mode === 'visual') {
      setJsonText(settingsDraftToJson(nextDraft));
      setJsonDirty(false);
    }
    scheduleVisualSave(nextDraft);
  }
```

- [ ] **Step 5: Add JSON save**

```ts
  async function saveJson() {
    const parsed = parseSettingsJsonText(jsonText);
    if (!parsed.ok) {
      setStatus('invalid');
      setStatusMessage(parsed.errorMessage);
      return;
    }
    try {
      validateSettingsJson(settingsDraftToJson(parsed.draft));
      setStatus('saving');
      setStatusMessage(null);
      const response = await client.saveSettingsConfig(settingsDraftToJson(parsed.draft));
      const savedDraft = parseSettingsDraft(response.content);
      setPathLabel(response.pathLabel);
      setDraft(savedDraft);
      setJsonText(settingsDraftToJson(savedDraft));
      setJsonDirty(false);
      setStatus('saved');
    } catch (error) {
      setStatus('failed');
      setStatusMessage(asErrorMessage(error));
    }
  }
```

- [ ] **Step 6: Add mode switching guard**

```ts
  function selectMode(nextMode: 'visual' | 'json') {
    if (nextMode === mode) return;
    if (mode === 'json' && jsonDirty) {
      const discard = window.confirm('Discard unsaved JSON changes?');
      if (!discard) return;
      if (draft) {
        setJsonText(settingsDraftToJson(draft));
      }
      setJsonDirty(false);
    }
    if (nextMode === 'json' && draft) {
      setJsonText(settingsDraftToJson(draft));
      setJsonDirty(false);
    }
    setMode(nextMode);
  }
```

- [ ] **Step 7: Render visual sections**

Render sections in this order:

```tsx
<SettingsSection title="Storage">
  <SettingsRow label="Storage URI" description="storage.uri">
    <input value={getSettingString(draft, ['storage', 'uri'])} onChange={(event) => updateVisual(['storage', 'uri'], event.target.value)} />
  </SettingsRow>
  <SettingsRow label="Storage options" description="storage.storageOptions">
    <textarea value={getSettingObjectText(draft, ['storage', 'storageOptions'])} onChange={(event) => {
      const parsed = parseSettingsJsonText(event.target.value);
      if (parsed.ok) updateVisual(['storage', 'storageOptions'], parsed.draft.root);
    }} />
  </SettingsRow>
</SettingsSection>
```

Render the remaining sections with these paths:

```tsx
<SettingsSection title="Providers">
  <SettingsRow label="LLM providers" description="llm.*">
    <ProviderList draft={draft} onChange={updateVisual} />
  </SettingsRow>
</SettingsSection>

<SettingsSection title="Extractor">
  <SettingsRow label="Recall mode" description="extraction.recallMode">
    <select value={getSettingString(draft, ['extraction', 'recallMode'])} onChange={(event) => updateVisual(['extraction', 'recallMode'], event.target.value)}>
      <option value="vector">vector</option>
      <option value="fts">fts</option>
      <option value="hybrid">hybrid</option>
    </select>
  </SettingsRow>
  <SettingsRow label="Default importance" description="extraction.defaultImportance">
    <input value={getSettingNumber(draft, ['extraction', 'defaultImportance'])} onChange={(event) => updateNumber(['extraction', 'defaultImportance'], event.target.value, false)} />
  </SettingsRow>
  <SettingsRow label="Embedding provider" description="extraction.embedding.provider">
    <input value={getSettingString(draft, ['extraction', 'embedding', 'provider'])} onChange={(event) => updateVisual(['extraction', 'embedding', 'provider'], event.target.value)} />
  </SettingsRow>
  <SettingsRow label="Embedding model" description="extraction.embedding.model">
    <input value={getSettingString(draft, ['extraction', 'embedding', 'model'])} onChange={(event) => updateVisual(['extraction', 'embedding', 'model'], event.target.value)} />
  </SettingsRow>
  <SettingsRow label="Embedding dimensions" description="extraction.embedding.dimensions">
    <input value={getSettingNumber(draft, ['extraction', 'embedding', 'dimensions'])} onChange={(event) => updateNumber(['extraction', 'embedding', 'dimensions'], event.target.value, true)} />
  </SettingsRow>
</SettingsSection>

<SettingsSection title="Observer">
  <SettingsRow label="Name" description="observer.name">
    <input value={getSettingString(draft, ['observer', 'name'])} onChange={(event) => updateVisual(['observer', 'name'], event.target.value)} />
  </SettingsRow>
  <SettingsRow label="LLM profile" description="observer.llm">
    <input value={getSettingString(draft, ['observer', 'llm'])} onChange={(event) => updateVisual(['observer', 'llm'], event.target.value)} />
  </SettingsRow>
  <SettingsRow label="Max attempts" description="observer.maxAttempts">
    <input value={getSettingNumber(draft, ['observer', 'maxAttempts'])} onChange={(event) => updateNumber(['observer', 'maxAttempts'], event.target.value, true)} />
  </SettingsRow>
  <SettingsRow label="Active window days" description="observer.activeWindowDays">
    <input value={getSettingNumber(draft, ['observer', 'activeWindowDays'])} onChange={(event) => updateNumber(['observer', 'activeWindowDays'], event.target.value, true)} />
  </SettingsRow>
</SettingsSection>

<SettingsSection title="Maintenance">
  <SettingsRow label="Watchdog" description="watchdog.enabled">
    <input type="checkbox" checked={getSettingBoolean(draft, ['watchdog', 'enabled'])} onChange={(event) => updateVisual(['watchdog', 'enabled'], event.target.checked)} />
  </SettingsRow>
  <SettingsRow label="Interval" description="watchdog.intervalMs">
    <input value={getSettingNumber(draft, ['watchdog', 'intervalMs'])} onChange={(event) => updateNumber(['watchdog', 'intervalMs'], event.target.value, true)} />
  </SettingsRow>
  <SettingsRow label="Compact fragments" description="watchdog.compactMinFragments">
    <input value={getSettingNumber(draft, ['watchdog', 'compactMinFragments'])} onChange={(event) => updateNumber(['watchdog', 'compactMinFragments'], event.target.value, true)} />
  </SettingsRow>
  <SettingsRow label="Index partitions" description="watchdog.extraction.targetPartitionSize">
    <input value={getSettingNumber(draft, ['watchdog', 'extraction', 'targetPartitionSize'])} onChange={(event) => updateNumber(['watchdog', 'extraction', 'targetPartitionSize'], event.target.value, true)} />
  </SettingsRow>
  <SettingsRow label="Optimize merge count" description="watchdog.extraction.optimizeMergeCount">
    <input value={getSettingNumber(draft, ['watchdog', 'extraction', 'optimizeMergeCount'])} onChange={(event) => updateNumber(['watchdog', 'extraction', 'optimizeMergeCount'], event.target.value, true)} />
  </SettingsRow>
</SettingsSection>
```

For numeric inputs, implement:

```ts
function updateNumber(path: SettingPath, raw: string, integer: boolean) {
  const parsed = integer ? parseOptionalInteger(raw) : parseOptionalNumber(raw);
  if (Number.isNaN(parsed)) {
    setStatus('invalid');
    setStatusMessage(`${path.join('.')} must be a ${integer ? 'integer' : 'number'}.`);
    return;
  }
  updateVisual(path, parsed);
}
```

- [ ] **Step 8: Render JSON mode**

JSON mode structure:

```tsx
<div className="settings-json-panel">
  <textarea
    className="settings-json-editor"
    spellCheck={false}
    value={jsonText}
    onChange={(event) => {
      setJsonText(event.target.value);
      setJsonDirty(true);
      setStatus('idle');
    }}
  />
  <div className="settings-json-actions">
    <Button onClick={() => void saveJson()} disabled={!jsonDirty || status === 'saving'}>
      {status === 'saving' ? 'Saving...' : 'Save JSON'}
    </Button>
    {statusMessage ? <span className="settings-status-error">{statusMessage}</span> : null}
  </div>
</div>
```

- [ ] **Step 9: Add CSS**

Add styles for:

- `.settings-page`
- `.settings-status-row`
- `.settings-mode-tabs`
- `.settings-section`
- `.settings-card`
- `.settings-row`
- `.settings-control`
- `.settings-json-panel`
- `.settings-json-editor`
- `.settings-json-actions`
- `.settings-unavailable`

Use the Codex visual direction from the spec: white background, centered column, list cards, row labels, helper text, right controls, and no large page title.

- [ ] **Step 10: Build**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/board exec vite build
```

Expected: PASS.

## Task 4: Browser Verification

**Files:**
- Verify: `packages/board/src/components/SettingsDialog.tsx`
- Verify: `packages/board/src/styles.css`

- [ ] **Step 1: Start Vite**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/board exec vite --host 127.0.0.1 --port 5173
```

Expected: local server at `http://127.0.0.1:5173/`.

- [ ] **Step 2: Open Settings demo**

Open:

```text
http://127.0.0.1:5173/?demo=1#/settings
```

Expected:

- No flicker.
- No large `Settings` title.
- Status row shows `muninn.json` and unavailable state if API is absent.
- Visual tab appears first.
- Sections appear in this order: Storage, Providers, Extractor, Observer, Maintenance.

- [ ] **Step 3: Check JSON mode**

Click `JSON`.

Expected:

- Full JSON editor appears.
- `Save JSON` is below the editor and left aligned.
- Button is disabled until text changes.

- [ ] **Step 4: Check dirty JSON switch guard**

Edit JSON text, then click `Visual`.

Expected:

- A discard confirmation appears.
- Cancelling stays on JSON.
- Confirming discards JSON text changes and returns to Visual.

- [ ] **Step 5: Stop Vite**

Stop the Vite process started for verification.

## Self-Review

- Spec coverage:
  - Section order is covered by Task 3 Step 7.
  - Visual autosave is covered by Task 3 Steps 3-4.
  - JSON manual save is covered by Task 3 Steps 5 and 8.
  - No large title is covered by Task 4 Step 2.
  - Demo no-flicker is covered by Task 3 Step 2 and Task 4 Step 2.
  - Validation schema alignment is covered by Task 2.
- Placeholder scan:
  - No `TBD` or `TODO` markers are present.
- Type consistency:
  - `MuninnSettingsDraft`, `SettingPath`, `parseSettingsDraft`, `settingsDraftToJson`, and `updateSettingPath` are defined in Task 1 and reused consistently.
