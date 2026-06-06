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
    storageOptions: {
      region: 'local',
    },
  },
  providers: {
    llm: {
      default: {
        type: 'mock',
      },
    },
    embedding: {
      default: {
        type: 'mock',
        dimensions: 8,
      },
    },
  },
  extractor: {
    name: 'default-extractor',
    llmProvider: 'default',
    embeddingProvider: 'default',
    recallMode: 'hybrid',
    maxAttempts: 3,
    activeWindowDays: 30,
  },
  observer: {
    name: 'default-observer',
    llmProvider: 'default',
    maxAttempts: 3,
    activeWindowDays: 30,
  },
  watchdog: {
    enabled: true,
    intervalMs: 60000,
    compactMinFragments: 8,
    extraction: {
      targetPartitionSize: 1024,
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
