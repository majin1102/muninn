import { CircleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { BoardClient } from '../lib/api.js';
import {
  getSettingValue,
  parseSettingsDraft,
  parseSettingsJsonText,
  settingsDraftToJson,
  type JsonObject,
  type MuninnSettingsDraft,
} from '../lib/settings-model.js';
import { asErrorMessage } from '../lib/utils.js';
import { validateSettingsJson } from '../server/settings.js';
import { Button } from './ui/button.js';

type SettingsPageProps = {
  client: BoardClient;
};

type SettingsMode = 'visual' | 'json';
type SaveStatus = 'idle' | 'loading' | 'saved' | 'saving' | 'invalid' | 'failed' | 'unavailable';
const DEFAULT_DATABASE = 'main';
const DEFAULT_MUNINN_HOME = '/Users/Nathan/.muninn';
const DEFAULT_WATCHDOG_CONFIG = {
  enabled: true,
  intervalMs: 60000,
  compactMinFragments: 8,
  targetPartitionSize: 1024,
  optimizeMergeCount: 4,
};

export function SettingsPage({ client }: SettingsPageProps) {
  const [mode, setMode] = useState<SettingsMode>('visual');
  const [draft, setDraft] = useState<MuninnSettingsDraft | null>(null);
  const [jsonText, setJsonText] = useState('');
  const [jsonDirty, setJsonDirty] = useState(false);
  const [pathLabel, setPathLabel] = useState('');
  const [status, setStatus] = useState<SaveStatus>('loading');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    setStatus('loading');
    setStatusMessage(null);
    setDraft(null);
    setJsonText('');
    setJsonDirty(false);
    setPathLabel('');

    client.getSettingsConfig()
      .then((response) => {
        if (cancelled) {
          return;
        }
        setPathLabel(response.pathLabel);
        setJsonText(response.content);
        try {
          validateSettingsJson(response.content);
          const nextDraft = parseSettingsDraft(response.content);
          setDraft(nextDraft);
          setJsonText(settingsDraftToJson(nextDraft));
          setStatus('saved');
        } catch (validationError) {
          setDraft(null);
          setMode('json');
          setStatus('invalid');
          setStatusMessage(asErrorMessage(validationError));
        }
      })
      .catch((loadError: unknown) => {
        if (cancelled) {
          return;
        }
        setDraft(null);
        setJsonText('');
        setPathLabel('');
        setStatus('unavailable');
        setStatusMessage(asErrorMessage(loadError));
      });

    return () => {
      cancelled = true;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, [client]);

  async function saveJson() {
    const parsed = parseSettingsJsonText(jsonText);
    if (!parsed.ok) {
      setStatus('invalid');
      setStatusMessage(parsed.errorMessage);
      return;
    }

    const nextJson = settingsDraftToJson(parsed.draft);
    try {
      validateSettingsJson(nextJson);
    } catch (validationError) {
      setStatus('invalid');
      setStatusMessage(asErrorMessage(validationError));
      return;
    }

    try {
      setStatus('saving');
      setStatusMessage(null);
      const response = await client.saveSettingsConfig(nextJson);
      const savedDraft = parseSettingsDraft(response.content);
      setDraft(savedDraft);
      setJsonText(settingsDraftToJson(savedDraft));
      setJsonDirty(false);
      setPathLabel(response.pathLabel);
      setStatus('saved');
    } catch (saveError) {
      setStatus('failed');
      setStatusMessage(asErrorMessage(saveError));
    }
  }

  function selectMode(nextMode: SettingsMode) {
    if (nextMode === mode) {
      return;
    }
    if (mode === 'json' && jsonDirty) {
      const discard = window.confirm('Discard unsaved JSON changes?');
      if (!discard) {
        return;
      }
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

  const schemaMismatch = status === 'invalid' && draft === null;
  const inlineStatus = inlineStatusLabel(status);

  return (
    <section className={`settings-page settings-page-${mode}`}>
      <div className="settings-mode-tabs" role="tablist" aria-label="Settings editor mode">
        <button
          className={mode === 'visual' ? 'settings-mode-tab settings-mode-tab-active' : 'settings-mode-tab'}
          type="button"
          disabled={schemaMismatch}
          aria-disabled={schemaMismatch}
          onClick={() => selectMode('visual')}
        >
          Visual
        </button>
        <button className={mode === 'json' ? 'settings-mode-tab settings-mode-tab-active' : 'settings-mode-tab'} type="button" onClick={() => selectMode('json')}>
          Json
        </button>
      </div>
      {schemaMismatch ? (
        <div className="settings-readonly-tip settings-schema-tip">
          <CircleAlert aria-hidden="true" />
          <span>Current settings schema does not match. Use Json to update muninn.json.</span>
        </div>
      ) : mode === 'visual' ? (
        <div className="settings-readonly-tip">
          <CircleAlert aria-hidden="true" />
          <span>Visual mode is read-only. Use Json to edit and save muninn.json.</span>
        </div>
      ) : null}

      {mode === 'visual' && inlineStatus && status !== 'unavailable' ? (
        <div className={`settings-inline-status settings-inline-status-${status}`}>
          <span>{inlineStatus}</span>
          {statusMessage ? <span>{statusMessage}</span> : null}
        </div>
      ) : null}

      {status === 'loading' ? <div className="empty-state">Loading muninn.json...</div> : null}

      {status === 'unavailable' ? (
        <div className="settings-unavailable">
          <strong>Settings unavailable</strong>
          <span>Run Board from the sidecar to edit muninn.json.</span>
          {statusMessage ? <span>{statusMessage}</span> : null}
        </div>
      ) : null}

      {mode === 'visual' ? (
        draft ? (
          <VisualSettings draft={draft} pathLabel={pathLabel} />
        ) : null
      ) : (
        <div className="settings-json-panel">
          <textarea
            className="settings-json-editor"
            spellCheck={false}
            value={jsonText}
            onChange={(event) => {
              setJsonText(event.target.value);
              setJsonDirty(true);
              setStatus('idle');
              setStatusMessage(null);
            }}
          />
          <div className="settings-json-actions">
            <Button onClick={() => void saveJson()} disabled={!jsonDirty || status === 'saving'}>
              {status === 'saving' ? 'Saving...' : 'Save'}
            </Button>
            {statusMessage ? <span className="settings-status-error">{statusMessage}</span> : null}
          </div>
        </div>
      )}

      {mode === 'visual' && statusMessage && status !== 'unavailable' ? (
        <div className="settings-status-error">{statusMessage}</div>
      ) : null}
    </section>
  );
}

function VisualSettings({ draft, pathLabel }: { draft: MuninnSettingsDraft; pathLabel: string }) {
  const llmProviders = providerEntries(getSettingValue(draft, ['providers', 'llm']));
  const [providerCapability, setProviderCapability] = useState<'llm' | 'embedding'>(
    llmProviders.length > 0 ? 'llm' : 'embedding',
  );

  return (
    <div className="settings-visual">
      <SettingsSection title="Storage">
        <StorageRows draft={draft} pathLabel={pathLabel} />
      </SettingsSection>

      <SettingsSection
        title="Providers"
        unframed
        action={(
          <ProviderCapabilityTabs
            capability={providerCapability}
            onSelect={setProviderCapability}
          />
        )}
      >
        <ProviderGroups draft={draft} capability={providerCapability} />
      </SettingsSection>

      <SettingsSection title="Extractor">
        <OptionalSettingsRow draft={draft} label="Name" description="extractor.name" path={['extractor', 'name']} />
        <OptionalSettingsRow draft={draft} label="LLM provider" description="extractor.llmProvider" path={['extractor', 'llmProvider']} />
        <OptionalSettingsRow draft={draft} label="Embedding provider" description="extractor.embeddingProvider" path={['extractor', 'embeddingProvider']} />
        <OptionalSettingsRow draft={draft} label="Recall mode" description="extractor.recallMode" path={['extractor', 'recallMode']} />
        <OptionalSettingsRow draft={draft} label="Max attempts" description="extractor.maxAttempts" path={['extractor', 'maxAttempts']} />
        <OptionalSettingsRow draft={draft} label="Active window days" description="extractor.activeWindowDays" path={['extractor', 'activeWindowDays']} />
      </SettingsSection>

      <SettingsSection title="Observer">
        <OptionalSettingsRow draft={draft} label="Name" description="observer.name" path={['observer', 'name']} />
        <OptionalSettingsRow draft={draft} label="LLM provider" description="observer.llmProvider" path={['observer', 'llmProvider']} />
        <OptionalSettingsRow draft={draft} label="Max attempts" description="observer.maxAttempts" path={['observer', 'maxAttempts']} />
        <OptionalSettingsRow draft={draft} label="Anchor threshold" description="observer.anchorThreshold" path={['observer', 'anchorThreshold']} />
        <OptionalSettingsRow draft={draft} label="Anchor batch size" description="observer.anchorBatchSize" path={['observer', 'anchorBatchSize']} />
        <OptionalSettingsRow draft={draft} label="Content budget" description="observer.contentBudgetChars" path={['observer', 'contentBudgetChars']} />
      </SettingsSection>

      <SettingsSection title="Maintenance">
        <EffectiveSettingsRow draft={draft} label="Watchdog" path={['watchdog', 'enabled']} defaultValue={DEFAULT_WATCHDOG_CONFIG.enabled} />
        <EffectiveSettingsRow draft={draft} label="Interval" path={['watchdog', 'intervalMs']} defaultValue={DEFAULT_WATCHDOG_CONFIG.intervalMs} />
        <EffectiveSettingsRow draft={draft} label="Compact fragments" path={['watchdog', 'compactMinFragments']} defaultValue={DEFAULT_WATCHDOG_CONFIG.compactMinFragments} />
        <EffectiveSettingsRow draft={draft} label="Index partitions" path={['watchdog', 'extraction', 'targetPartitionSize']} defaultValue={DEFAULT_WATCHDOG_CONFIG.targetPartitionSize} />
        <EffectiveSettingsRow draft={draft} label="Optimize merge count" path={['watchdog', 'extraction', 'optimizeMergeCount']} defaultValue={DEFAULT_WATCHDOG_CONFIG.optimizeMergeCount} />
      </SettingsSection>
    </div>
  );
}

function ProviderGroups({ draft, capability }: { draft: MuninnSettingsDraft; capability: 'llm' | 'embedding' }) {
  const llm = getSettingValue(draft, ['providers', 'llm']);
  const embedding = getSettingValue(draft, ['providers', 'embedding']);
  const llmEntries = providerEntries(llm);
  const embeddingEntries = providerEntries(embedding);
  const [selectedProfiles, setSelectedProfiles] = useState<Record<string, string>>({});
  const entries = capability === 'llm' ? llmEntries : embeddingEntries;
  const fields = capability === 'llm'
    ? ['type', 'model', 'api', 'baseUrl', 'apiKey']
    : ['type', 'model', 'baseUrl', 'apiKey', 'dimensions'];
  const selected = selectedProfiles[capability] ?? '';
  const activeName = entries.some(([name]) => name === selected) ? selected : entries[0]?.[0] ?? '';
  const active = entries.find(([name]) => name === activeName)?.[1];
  const config = isJsonObject(active) ? active : {};
  const visibleFields = fields.filter((field) => hasDisplayValue(config[field]));

  if (llmEntries.length === 0 && embeddingEntries.length === 0) {
    return null;
  }

  function selectProfile(name: string) {
    setSelectedProfiles((current) => ({
      ...current,
      [capability]: name,
    }));
  }

  return (
    <div className="settings-provider-list">
      {entries.length === 0 ? (
        <div className="settings-provider-empty">No {capability} providers</div>
      ) : (
        <div className="settings-provider-shell">
          <div className="settings-provider-profile-tabs" role="tablist" aria-label={`${capability} provider profiles`}>
            {entries.map(([name]) => (
              <button
                className={name === activeName ? 'settings-provider-profile settings-provider-profile-active' : 'settings-provider-profile'}
                key={name}
                type="button"
                onClick={() => selectProfile(name)}
              >
                {name}
              </button>
            ))}
          </div>
          <div className="settings-provider-detail">
            {visibleFields.length > 0 ? (
              visibleFields.map((field) => (
                <div className="settings-kv-row" key={field}>
                  <span>{field}</span>
                  <SettingsValue value={formatSettingValue(config[field])} />
                </div>
              ))
            ) : (
              <div className="settings-provider-empty">No visible fields</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ProviderCapabilityTabs({ capability, onSelect }: { capability: 'llm' | 'embedding'; onSelect: (capability: 'llm' | 'embedding') => void }) {
  return (
    <div className="settings-provider-capability-tabs" role="tablist" aria-label="Provider capability">
      <button
        className={capability === 'llm' ? 'settings-provider-capability-tab settings-provider-capability-tab-active' : 'settings-provider-capability-tab'}
        type="button"
        onClick={() => onSelect('llm')}
      >
        LLM
      </button>
      <button
        className={capability === 'embedding' ? 'settings-provider-capability-tab settings-provider-capability-tab-active' : 'settings-provider-capability-tab'}
        type="button"
        onClick={() => onSelect('embedding')}
      >
        Embedding
      </button>
    </div>
  );
}

function providerEntries(value: unknown): Array<[string, unknown]> {
  return isJsonObject(value) ? Object.entries(value) : [];
}

function OptionalSettingsRow({ draft, label, description, path }: { draft: MuninnSettingsDraft; label: string; description: string; path: [string, ...string[]] }) {
  const value = getSettingValue(draft, path);
  if (!hasDisplayValue(value)) {
    return null;
  }
  return (
    <SettingsRow label={label} description={description}>
      <SettingsValue value={formatSettingValue(value)} />
    </SettingsRow>
  );
}

function EffectiveSettingsRow({ draft, label, path, defaultValue }: { draft: MuninnSettingsDraft; label: string; path: [string, ...string[]]; defaultValue: string | number | boolean }) {
  const value = getSettingValue(draft, path);
  const hasValue = hasDisplayValue(value);
  return (
    <SettingsRow label={label} description={path.join('.')}>
      <SettingsValue value={formatSettingValue(hasValue ? value : defaultValue)} />
    </SettingsRow>
  );
}

function SettingsValue({ value }: { value: string }) {
  return <span className="settings-readonly-value">{value}</span>;
}

function StorageRows({ draft, pathLabel }: { draft: MuninnSettingsDraft; pathLabel: string }) {
  const configuredUri = getSettingValue(draft, ['storage', 'uri']);
  const hasConfiguredUri = typeof configuredUri === 'string' && configuredUri.trim().length > 0;
  const targetUri = hasConfiguredUri
    ? appendDatabaseToStorageUri(configuredUri.trim(), DEFAULT_DATABASE)
    : defaultStorageTargetUri(pathLabel);

  return (
    <>
      <SettingsRow label="Storage URI" description="Where Muninn stores local data">
        <SettingsValue value={targetUri} />
      </SettingsRow>
      <StorageOptionsRows draft={draft} />
    </>
  );
}

function defaultStorageTargetUri(pathLabel: string): string {
  return `file-object-store://${muninnHomeFromPathLabel(pathLabel)}/${DEFAULT_DATABASE}`;
}

function muninnHomeFromPathLabel(pathLabel: string): string {
  const normalized = pathLabel.replace(/\\/g, '/');
  const suffix = '/muninn.json';
  if (normalized.endsWith(suffix)) {
    return normalized.slice(0, -suffix.length);
  }
  return DEFAULT_MUNINN_HOME;
}

function appendDatabaseToStorageUri(uri: string, database: string): string {
  return `${uri.replace(/\/+$/, '')}/${database}`;
}

function StorageOptionsRows({ draft }: { draft: MuninnSettingsDraft }) {
  const value = getSettingValue(draft, ['storage', 'storageOptions']);
  const entries = isJsonObject(value)
    ? Object.entries(value).filter(([, entry]) => hasDisplayValue(entry))
    : [];
  if (entries.length === 0) {
    return null;
  }
  return (
    <>
      {entries.map(([key, entry]) => (
        <SettingsRow label={key} description="Storage option" key={key}>
          <SettingsValue value={formatSettingValue(entry)} />
        </SettingsRow>
      ))}
    </>
  );
}

function formatSettingValue(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function hasDisplayValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value === 'boolean') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isJsonObject(value)) {
    return Object.keys(value).length > 0;
  }
  return false;
}

function SettingsSection({ title, children, action, unframed = false }: { title: string; children: ReactNode; action?: ReactNode; unframed?: boolean }) {
  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <h2>{title}</h2>
        {action ? <div className="settings-section-action">{action}</div> : null}
      </div>
      {unframed ? children : <div className="settings-card">{children}</div>}
    </section>
  );
}

function SettingsRow({ label, description, children }: { label: string; description: string; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <div>{label}</div>
        <span>{description}</span>
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

function inlineStatusLabel(status: SaveStatus): string | null {
  if (status === 'loading') {
    return 'Loading...';
  }
  if (status === 'saving') {
    return 'Saving...';
  }
  if (status === 'invalid') {
    return 'Invalid';
  }
  if (status === 'failed') {
    return 'Save failed';
  }
  if (status === 'unavailable') {
    return 'Unavailable';
  }
  return null;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
