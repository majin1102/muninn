import type { SearchSessionResult } from '@muninn/types';
import {
  ArrowUp,
  Bot,
  BotMessageSquare,
  Check,
  ChevronDown,
  ChevronUp,
  File,
  FileText,
  Folder,
  Image,
  Plus,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { logoForAgent, type AgentLogo } from '../lib/agent_logo.js';
import type { BoardClient, ProjectNode } from '../lib/api.js';
import {
  DEFAULT_SESSION_TOP_N,
  DEFAULT_TOP_N,
  defaultSearchControls,
  normalizeSearchN,
  sessionKeysForRequest,
  sessionOptionsForProjects,
  type SearchControlsState,
} from '../lib/search_state.js';
import { asErrorMessage } from '../lib/utils.js';

type SearchPageProps = {
  client: BoardClient;
  projects: ProjectNode[];
  projectsLoading: boolean;
  projectError: string | null;
  onLoadProjects: () => void;
};

const PROVIDER_OPTIONS = [
  { label: 'Default', value: 'default' },
  { label: 'OpenAI', value: 'openai' },
  { label: 'Local', value: 'local' },
];
const ADD_OPTIONS = [
  { label: 'Image', value: 'image', icon: Image },
  { label: 'File', value: 'file', icon: File },
  { label: 'Agent', value: 'agent', icon: Bot },
];
type SearchSourceKey = 'all' | 'observation' | 'conversation' | 'llmWiki';
const SOURCE_TABS: Array<{ label: string; value: SearchSourceKey }> = [
  { label: 'All', value: 'all' },
  { label: 'Observation', value: 'observation' },
  { label: 'Conversation', value: 'conversation' },
  { label: 'LLM Wiki', value: 'llmWiki' },
];
const SEARCH_FILTER_SINGLE_NAME_LIMIT = 24;
type SearchMenuKey = 'add' | 'provider' | 'project' | 'session' | 'topN';
type SearchOption = {
  label: string;
  value: string;
  agent?: string;
  description?: string;
  sessionKey?: string;
};

export function SearchPage({
  client,
  projects,
  projectsLoading,
  projectError,
  onLoadProjects,
}: SearchPageProps) {
  const [controls, setControls] = useState<SearchControlsState>(() => defaultSearchControls());
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SearchSessionResult[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [provider, setProvider] = useState(PROVIDER_OPTIONS[0]?.value ?? 'default');
  const [openMenu, setOpenMenu] = useState<SearchMenuKey | null>(null);
  const [sourceTab, setSourceTab] = useState<SearchSourceKey>('all');
  const [composerExpanded, setComposerExpanded] = useState(false);
  const composerRef = useRef<HTMLDivElement | null>(null);

  const projectOptions = useMemo<SearchOption[]>(
    () => projects.map((project) => ({ label: project.label, value: project.projectKey })),
    [projects],
  );
  const sessionOptions = useMemo(
    () => sessionOptionsForProjects(projects, controls.projectKeys),
    [controls.projectKeys, projects],
  );

  useEffect(() => {
    if (projects.length === 0 && !projectsLoading && !projectError) {
      onLoadProjects();
    }
  }, [onLoadProjects, projectError, projects.length, projectsLoading]);

  useEffect(() => {
    if (!openMenu) {
      return;
    }
    function closeOnOutsidePointerDown(event: PointerEvent) {
      closeMenuOnOutsidePointer(event);
    }
    function closeOnOutsideClick(event: MouseEvent) {
      closeMenuOnOutsidePointer(event);
    }
    document.addEventListener('pointerdown', closeOnOutsidePointerDown);
    document.addEventListener('click', closeOnOutsideClick);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointerDown);
      document.removeEventListener('click', closeOnOutsideClick);
    };
  }, [openMenu]);

  function patchControls(patch: Partial<SearchControlsState>) {
    setControls((current) => ({
      ...current,
      ...patch,
    }));
  }

  function toggleMenu(key: SearchMenuKey) {
    setOpenMenu((current) => (current === key ? null : key));
  }

  function isInsideComposer(event: Pick<Event, 'composedPath' | 'target'>) {
    const composer = composerRef.current;
    if (!composer) {
      return false;
    }
    if (event.composedPath().includes(composer)) {
      return true;
    }
    return event.target instanceof Node && composer.contains(event.target);
  }

  function closeMenuOnOutsidePointer(event: Pick<Event, 'composedPath' | 'target'>) {
    if (!openMenu || isInsideComposer(event)) {
      return;
    }
    setOpenMenu(null);
  }

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const query = controls.query.trim();
    if (!query) {
      return;
    }
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setOpenMenu(null);
    setComposerExpanded(false);
    setSubmitted(true);
    setLoading(true);
    setError(null);
    setExpanded({});
    try {
      const response = await client.search({
        query,
        projectKeys: controls.projectKeys,
        sessionKeys: sessionKeysForRequest(controls.sessionKeys, sessionOptions),
        sessionTopN: controls.sessionTopN,
        topN: controls.topN,
      });
      setResults(response.results);
    } catch (nextError) {
      setResults([]);
      setError(asErrorMessage(nextError));
    } finally {
      setLoading(false);
    }
  }

  function submitFromTextarea(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    event.currentTarget.blur();
    setComposerExpanded(false);
    void submit();
  }

  function resizeTextarea(event: FormEvent<HTMLTextAreaElement>) {
    const target = event.currentTarget;
    target.style.height = 'auto';
    target.style.height = `${Math.min(target.scrollHeight, 188)}px`;
  }

  function patchProjectKeys(projectKeys: string[]) {
    const allowedSessions = new Set(sessionOptionsForProjects(projects, projectKeys).map((option) => option.value));
    setControls((current) => ({
      ...current,
      projectKeys,
      sessionKeys: current.sessionKeys.filter((sessionKey) => allowedSessions.has(sessionKey)),
    }));
  }

  return (
    <div
      className={submitted ? 'search-page search-page-submitted' : 'search-page'}
      onPointerDownCapture={(event) => closeMenuOnOutsidePointer(event.nativeEvent)}
      onClickCapture={(event) => closeMenuOnOutsidePointer(event.nativeEvent)}
    >
      {!submitted ? <h1 className="search-prompt-title">Search context across all your agents</h1> : null}
      <form className="search-form" onSubmit={submit}>
        <div
          ref={composerRef}
          className={submitted && composerExpanded ? 'search-composer search-composer-expanded' : 'search-composer'}
        >
          <div className="search-input-shell">
            <textarea
              value={controls.query}
              rows={3}
              onChange={(event) => patchControls({ query: event.target.value })}
              onClick={() => setComposerExpanded(true)}
              onFocus={() => setComposerExpanded(true)}
              onPointerDown={() => setComposerExpanded(true)}
              onInput={resizeTextarea}
              onKeyDown={submitFromTextarea}
            />
            <div className="search-main-toolbar">
              <div className="search-main-tools">
                <SearchActionMenu
                  icon={Plus}
                  label="Add"
                  open={openMenu === 'add'}
                  onToggle={() => toggleMenu('add')}
                  onClose={() => setOpenMenu(null)}
                />
                <SearchSelectMenu
                  icon={BotMessageSquare}
                  label="Provider"
                  value={provider}
                  options={PROVIDER_OPTIONS}
                  open={openMenu === 'provider'}
                  hideLabel
                  onToggle={() => toggleMenu('provider')}
                  onChange={(value) => {
                    setProvider(value);
                    setOpenMenu(null);
                  }}
                />
              </div>
              <button className="search-submit-button" type="submit" aria-label="Search" disabled={!controls.query.trim() || loading}>
                <ArrowUp />
              </button>
            </div>
          </div>
          <div className="search-controls" aria-label="Search controls">
            <SearchTopMenu
              icon={SlidersHorizontal}
              globalValue={controls.topN}
              sessionValue={controls.sessionTopN}
              open={openMenu === 'topN'}
              onToggle={() => toggleMenu('topN')}
              onGlobalChange={(value) => {
                patchControls({ topN: normalizeSearchN(value, DEFAULT_TOP_N) });
              }}
              onSessionChange={(value) => {
                patchControls({ sessionTopN: normalizeSearchN(value, DEFAULT_SESSION_TOP_N) });
              }}
            />
            <SearchMultiSelectMenu
              icon={<Folder className="search-control-icon" />}
              label="Project"
              values={controls.projectKeys}
              disabled={projectsLoading}
              hideLabelWhenSingle
              singleNameLimit={SEARCH_FILTER_SINGLE_NAME_LIMIT}
              open={openMenu === 'project'}
              onToggle={() => toggleMenu('project')}
              onChange={patchProjectKeys}
              options={projectOptions}
            />
            <SearchMultiSelectMenu
              icon={<FileText className="search-control-icon" />}
              label="Session"
              values={controls.sessionKeys}
              hideLabelWhenSingle
              singleNameLimit={SEARCH_FILTER_SINGLE_NAME_LIMIT}
              open={openMenu === 'session'}
              onToggle={() => toggleMenu('session')}
              onChange={(sessionKeys) => patchControls({ sessionKeys })}
              options={sessionOptions}
              optionIcon={(option) => (option.agent ? <AgentLogoMark logo={logoForAgent(option.agent)} /> : null)}
            />
          </div>
        </div>
      </form>
      {submitted ? <SearchSourceTabs value={sourceTab} onChange={setSourceTab} /> : null}
      {projectError ? <div className="search-error">{projectError}</div> : null}
      {submitted ? (
        <SearchResults
          loading={loading}
          error={error}
          results={results}
          expanded={expanded}
          onToggle={(id) => setExpanded((current) => ({ ...current, [id]: !current[id] }))}
        />
      ) : null}
    </div>
  );
}

function SearchSourceTabs({
  value,
  onChange,
}: {
  value: SearchSourceKey;
  onChange: (value: SearchSourceKey) => void;
}) {
  return (
    <div className="search-source-tabs" role="tablist" aria-label="Search source">
      {SOURCE_TABS.map((tab) => (
        <button
          key={tab.value}
          className={tab.value === value ? 'search-source-tab search-source-tab-active' : 'search-source-tab'}
          type="button"
          role="tab"
          aria-selected={tab.value === value}
          onClick={() => onChange(tab.value)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function SearchTopMenu({
  icon: Icon,
  globalValue,
  sessionValue,
  open,
  onToggle,
  onGlobalChange,
  onSessionChange,
}: {
  icon: LucideIcon;
  globalValue: number;
  sessionValue: number;
  open: boolean;
  onToggle: () => void;
  onGlobalChange: (value: string) => void;
  onSessionChange: (value: string) => void;
}) {
  const [globalDraft, setGlobalDraft] = useState(String(globalValue));
  const [sessionDraft, setSessionDraft] = useState(String(sessionValue));

  useEffect(() => {
    setGlobalDraft(String(globalValue));
  }, [globalValue]);

  useEffect(() => {
    setSessionDraft(String(sessionValue));
  }, [sessionValue]);

  function commitGlobal() {
    const next = normalizeSearchN(globalDraft, globalValue);
    setGlobalDraft(String(next));
    onGlobalChange(String(next));
  }

  function commitSession() {
    const next = normalizeSearchN(sessionDraft, sessionValue);
    setSessionDraft(String(next));
    onSessionChange(String(next));
  }

  return (
    <div className="search-control-wrap">
      <button
        className="search-control"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        <Icon className="search-control-icon" />
        <span className="search-control-value">Top {globalValue}</span>
        <ChevronDown className="search-control-chevron" />
      </button>
      {open ? (
        <SearchPopover title="Top">
          <label className="search-number-row">
            <span>Global</span>
            <input
              type="number"
              min="1"
              step="1"
              value={globalDraft}
              onBlur={commitGlobal}
              onChange={(event) => setGlobalDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitGlobal();
                }
              }}
            />
          </label>
          <label className="search-number-row">
            <span>Session</span>
            <input
              type="number"
              min="1"
              step="1"
              value={sessionDraft}
              onBlur={commitSession}
              onChange={(event) => setSessionDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitSession();
                }
              }}
            />
          </label>
        </SearchPopover>
      ) : null}
    </div>
  );
}

function SearchMultiSelectMenu({
  icon,
  label,
  values,
  options,
  open,
  disabled = false,
  hideLabelWhenSingle = false,
  singleNameLimit,
  onToggle,
  onChange,
  optionIcon,
}: {
  icon: ReactNode;
  label: string;
  values: string[];
  options: SearchOption[];
  open: boolean;
  disabled?: boolean;
  hideLabelWhenSingle?: boolean;
  singleNameLimit?: number;
  onToggle: () => void;
  onChange: (values: string[]) => void;
  optionIcon?: (option: SearchOption) => ReactNode;
}) {
  const selected = new Set(values);
  const rawValueLabel = multiValueLabel(values, options);
  const isSingleValue = values.length === 1;
  const singleNameIsLong = isSingleValue
    && singleNameLimit !== undefined
    && rawValueLabel.length > singleNameLimit;
  const hideLabel = hideLabelWhenSingle && isSingleValue && !singleNameIsLong;
  const valueLabel = singleNameIsLong ? '1' : rawValueLabel;
  return (
    <div className="search-control-wrap">
      <button
        className={disabled ? 'search-control search-control-disabled' : 'search-control'}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={hideLabel ? `${label}: ${valueLabel}` : undefined}
        onClick={onToggle}
      >
        {icon}
        {hideLabel ? null : <span className="search-control-label">{label}</span>}
        <span className="search-control-value">{valueLabel}</span>
        <ChevronDown className="search-control-chevron" />
      </button>
      {open && !disabled ? (
        <SearchPopover title={label}>
          <button
            className={values.length === 0 ? 'search-menu-item search-menu-item-active' : 'search-menu-item'}
            type="button"
            onClick={() => onChange([])}
          >
            <span className={values.length === 0 ? 'search-menu-check search-menu-check-active' : 'search-menu-check'}>
              {values.length === 0 ? <Check /> : null}
            </span>
            <span className="search-menu-label">All</span>
          </button>
          {options.map((option) => {
            const isSelected = selected.has(option.value);
            return (
              <button
                key={option.value}
                className={[
                  'search-menu-item',
                  option.description ? 'search-menu-item-with-description' : '',
                  isSelected ? 'search-menu-item-active' : '',
                ].filter(Boolean).join(' ')}
                type="button"
                onClick={() => onChange(toggleValue(values, option.value))}
              >
                <span className={isSelected ? 'search-menu-check search-menu-check-active' : 'search-menu-check'}>
                  {isSelected ? <Check /> : null}
                </span>
                {optionIcon?.(option)}
                <span className="search-menu-copy">
                  <span className="search-menu-label">{option.label}</span>
                  {option.description ? <span className="search-menu-description">{option.description}</span> : null}
                </span>
              </button>
            );
          })}
        </SearchPopover>
      ) : null}
    </div>
  );
}

function SearchActionMenu({
  icon: Icon,
  label,
  open,
  onToggle,
  onClose,
}: {
  icon: LucideIcon;
  label: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  return (
    <div className="search-control-wrap">
      <button
        className="search-icon-control"
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        <Icon />
      </button>
      {open ? (
        <SearchPopover title={label}>
          {ADD_OPTIONS.map((option) => {
            const OptionIcon = option.icon;
            return (
              <button key={option.value} className="search-menu-item" type="button" onClick={onClose}>
                <OptionIcon />
                <span className="search-menu-label">{option.label}</span>
              </button>
            );
          })}
        </SearchPopover>
      ) : null}
    </div>
  );
}

function SearchSelectMenu({
  icon: Icon,
  label,
  value,
  options,
  open,
  hideLabel = false,
  disabled = false,
  onToggle,
  onChange,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  options: Array<{ label: string; value: string }>;
  open: boolean;
  hideLabel?: boolean;
  disabled?: boolean;
  onToggle: () => void;
  onChange: (value: string) => void;
}) {
  const selected = options.find((option) => option.value === value) ?? options[0];
  return (
    <div className="search-control-wrap">
      <button
        className={disabled ? 'search-control search-control-disabled' : 'search-control'}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        <Icon className="search-control-icon" />
        {hideLabel ? null : <span className="search-control-label">{label}</span>}
        <span className="search-control-value">{selected?.label ?? value}</span>
        <ChevronDown className="search-control-chevron" />
      </button>
      {open && !disabled ? (
        <SearchPopover title={label}>
          {options.map((option) => (
            <button
              key={option.value}
              className={option.value === value ? 'search-menu-item search-menu-item-active' : 'search-menu-item'}
              type="button"
              onClick={() => onChange(option.value)}
            >
              <span className={option.value === value ? 'search-menu-check search-menu-check-active' : 'search-menu-check'}>
                {option.value === value ? <Check /> : null}
              </span>
              <span className="search-menu-label">{option.label}</span>
            </button>
          ))}
        </SearchPopover>
      ) : null}
    </div>
  );
}

function SearchPopover({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="search-popover" role="menu" aria-label={title}>
      <div className="search-popover-title">{title}</div>
      {children}
    </div>
  );
}

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];
}

function multiValueLabel(values: string[], options: SearchOption[]): string {
  if (values.length === 0) {
    return 'All';
  }
  if (values.length === 1) {
    return options.find((option) => option.value === values[0])?.label ?? values[0]!;
  }
  return `${values.length}`;
}

function AgentLogoMark({ logo }: { logo: AgentLogo }) {
  return (
    <span className="search-session-agent-icon" title={logo.label}>
      {logo.fallback ? (
        <Bot className="agent-logo-fallback" aria-label={logo.label} />
      ) : (
        <img src={logo.src} alt={logo.label} className="agent-logo-image" />
      )}
    </span>
  );
}

function SearchResults({
  loading,
  error,
  results,
  expanded,
  onToggle,
}: {
  loading: boolean;
  error: string | null;
  results: SearchSessionResult[];
  expanded: Record<string, boolean>;
  onToggle: (id: string) => void;
}) {
  if (loading) {
    return <div className="search-status">Searching...</div>;
  }
  if (error) {
    return <div className="search-error">{error}</div>;
  }
  if (results.length === 0) {
    return <div className="search-status">No results found.</div>;
  }
  return (
    <div className="search-results">
      {results.map((result) => (
        <article key={result.sessionKey} className="search-result">
          <h2>{result.sessionLabel}</h2>
          <div className="search-result-meta">Project: {result.projectKey}</div>
          <div className="search-result-items">
            {result.items.map((item) => {
              const isExpandable = shouldPreview(item.content);
              const isExpanded = Boolean(expanded[item.id]);
              return (
                <section key={item.id} className="search-hit">
                  <div className="search-hit-source">Source: {item.source}</div>
                  {item.title ? <h3>{item.title}</h3> : null}
                  <div className={hitContentClass(isExpandable, isExpanded)}>
                    {item.content}
                  </div>
                  {isExpandable ? (
                    <button className="search-hit-toggle" type="button" onClick={() => onToggle(item.id)}>
                      {isExpanded ? <ChevronUp /> : <ChevronDown />}
                      <span>{isExpanded ? 'Collapse' : 'Expand'}</span>
                    </button>
                  ) : null}
                </section>
              );
            })}
          </div>
        </article>
      ))}
    </div>
  );
}

function shouldPreview(content: string): boolean {
  return content.length > 220 || content.split('\n').length > 3;
}

function hitContentClass(isExpandable: boolean, isExpanded: boolean): string {
  if (!isExpandable) {
    return 'search-hit-content search-hit-content-complete';
  }
  return isExpanded ? 'search-hit-content search-hit-content-expanded' : 'search-hit-content';
}
