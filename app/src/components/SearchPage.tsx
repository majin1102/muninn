import type { RecallProviderOption, SearchSessionResult } from '@muninn/types';
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  File,
  FileText,
  Folder,
  Image,
  Plus,
  type LucideIcon,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentType,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SVGProps,
} from 'react';
import ReactMarkdown from 'react-markdown';
import muninnLogo from '../assets/muninn-raven-logo.png';
import { logoForAgent, type AgentLogo } from '../lib/agent_logo.js';
import type { AppClient, ProjectNode } from '../lib/api.js';
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

type RecallPageProps = {
  client: AppClient;
  projects: ProjectNode[];
  projectsLoading: boolean;
  projectError: string | null;
  onLoadProjects: () => void;
};

const FALLBACK_PROVIDER_OPTIONS: RecallProviderOption[] = [
  { label: 'None', value: 'none' },
  { label: 'Default', value: 'default' },
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
const DEFAULT_SEARCH_SPLIT_RATIO = 52;
const MIN_SEARCH_SPLIT_RATIO = 42;
const MAX_SEARCH_SPLIT_RATIO = 62;
type SearchMenuKey = 'add' | 'provider' | 'project' | 'session' | 'topN';
type SearchOption = {
  label: string;
  value: string;
  agent?: string;
  description?: string;
  sessionKey?: string;
};
type AgentRecallStatus = 'idle' | 'thinking' | 'streaming' | 'done' | 'error';

type SvgIcon = ComponentType<SVGProps<SVGSVGElement>>;
type SearchLayoutStyle = CSSProperties & {
  '--search-answer-ratio'?: string;
};

function ProviderModelIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M15 20.5v-3.3c0-1.2.4-2.3 1.2-3.2A7.2 7.2 0 0 0 18 9.1a7 7 0 0 0-7.1-6.7 6.7 6.7 0 0 0-6.6 5.9 8 8 0 0 1-.8 2.8l-1 1.8c-.3.6.1 1.3.8 1.3h1.4v2.2c0 1 .8 1.8 1.8 1.8h2.2v2.3" />
    </svg>
  );
}

function TopNIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <g transform="translate(12 12) scale(.9) translate(-12 -12)">
        <path d="M21 4h-7" />
        <path d="M10 4H3" />
        <path d="M21 12h-9" />
        <path d="M8 12H3" />
        <path d="M21 20h-5" />
        <path d="M12 20H3" />
        <path d="M14 2v4" />
        <path d="M8 10v4" />
        <path d="M16 18v4" />
      </g>
    </svg>
  );
}

export function RecallPage({
  client,
  projects,
  projectsLoading,
  projectError,
  onLoadProjects,
}: RecallPageProps) {
  const [controls, setControls] = useState<SearchControlsState>(() => controlsFromRecallHash());
  const [submitted, setSubmitted] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [agentStatus, setAgentStatus] = useState<AgentRecallStatus>('idle');
  const [agentError, setAgentError] = useState<string | null>(null);
  const [answerText, setAnswerText] = useState('');
  const [results, setResults] = useState<SearchSessionResult[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [providerOptions, setProviderOptions] = useState<RecallProviderOption[]>(FALLBACK_PROVIDER_OPTIONS);
  const [providerReady, setProviderReady] = useState(false);
  const [provider, setProvider] = useState(() => providerFromRecallHash());
  const [openMenu, setOpenMenu] = useState<SearchMenuKey | null>(null);
  const [sourceTab, setSourceTab] = useState<SearchSourceKey>('all');
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [splitRatio, setSplitRatio] = useState(DEFAULT_SEARCH_SPLIT_RATIO);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const splitLayoutRef = useRef<HTMLDivElement | null>(null);
  const agentAbortRef = useRef<AbortController | null>(null);
  const openMenuRef = useRef<SearchMenuKey | null>(null);
  const submittedRef = useRef(false);
  const composerExpandedRef = useRef(false);
  const restoreRecallSearchRef = useRef(controls.query.trim().length > 0);

  openMenuRef.current = openMenu;
  submittedRef.current = submitted;
  composerExpandedRef.current = composerExpanded;

  const projectOptions = useMemo<SearchOption[]>(
    () => projects.map((project) => ({ label: project.label, value: project.projectKey })),
    [projects],
  );
  const sessionOptions = useMemo(
    () => sessionOptionsForProjects(projects, controls.projectKeys),
    [controls.projectKeys, projects],
  );

  // Auto-load projects once. Guard with a ref so a legitimately empty result
  // does not retrigger the effect (projectsLoading flips while projects stays
  // empty), which otherwise loops forever and flickers the Project control.
  const autoLoadedProjects = useRef(false);
  useEffect(() => {
    if (!autoLoadedProjects.current && projects.length === 0 && !projectsLoading && !projectError) {
      autoLoadedProjects.current = true;
      onLoadProjects();
    }
  }, [onLoadProjects, projectError, projects.length, projectsLoading]);

  useEffect(() => {
    writeRecallHash(controls, provider);
  }, [controls, provider]);

  useEffect(() => {
    let cancelled = false;
    void client.getRecallProviders()
      .then((response) => {
        if (cancelled) {
          return;
        }
        const providers = response.providers.length > 0 ? response.providers : FALLBACK_PROVIDER_OPTIONS;
        setProviderOptions(providers);
        setProvider((current) => normalizeRecallProvider(current, providers));
        setProviderReady(true);
      })
      .catch(() => {
        if (!cancelled) {
          setProviderOptions(FALLBACK_PROVIDER_OPTIONS);
          setProvider((current) => normalizeRecallProvider(current, FALLBACK_PROVIDER_OPTIONS));
          setProviderReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => () => {
    agentAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!providerReady || !restoreRecallSearchRef.current) {
      return;
    }
    restoreRecallSearchRef.current = false;
    void submit();
  }, [providerReady]);

  useEffect(() => {
    function closeOnOutsidePointerDown(event: PointerEvent) {
      if (isInsideComposer(event)) {
        return;
      }
      if (openMenuRef.current) {
        setOpenMenu(null);
      }
      if (submittedRef.current && composerExpandedRef.current) {
        setComposerExpanded(false);
      }
    }
    document.addEventListener('pointerdown', closeOnOutsidePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointerDown, true);
    };
  }, []);

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
    if (isInsideComposer(event)) {
      return;
    }
    if (openMenu) {
      setOpenMenu(null);
    }
    if (submitted && composerExpanded) {
      setComposerExpanded(false);
    }
  }

  function updateSplitRatio(clientX: number) {
    const layout = splitLayoutRef.current;
    if (!layout) {
      return;
    }
    const rect = layout.getBoundingClientRect();
    if (rect.width <= 0) {
      return;
    }
    setSplitRatio(clampSearchSplitRatio(((clientX - rect.left) / rect.width) * 100));
  }

  function beginSplitDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    updateSplitRatio(event.clientX);
  }

  function dragSplit(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }
    updateSplitRatio(event.clientX);
  }

  function endSplitDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const query = controls.query.trim();
    if (!query) {
      return;
    }
    agentAbortRef.current?.abort();
    const agentAbort = new AbortController();
    agentAbortRef.current = agentAbort;
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setOpenMenu(null);
    setComposerExpanded(false);
    setSubmitted(true);
    setSearchLoading(true);
    setSearchError(null);
    setAgentStatus('idle');
    setAgentError(null);
    setAnswerText('');
    setExpanded({});
    let searchCompleted = false;
    try {
      const response = await client.searchRecall({
        query,
        projectKeys: controls.projectKeys,
        sessionKeys: sessionKeysForRequest(controls.sessionKeys, sessionOptions),
        sessionTopN: controls.sessionTopN,
        topN: controls.topN,
        signal: agentAbort.signal,
      });
      if (agentAbort.signal.aborted) {
        return;
      }
      setResults(response.results);
      searchCompleted = true;
      setSearchLoading(false);
      if (provider === 'none' || response.results.length === 0) {
        return;
      }
      setAgentStatus('thinking');
      await waitForPaint();
      if (agentAbort.signal.aborted) {
        return;
      }
      await client.streamAgentRecall({
        query,
        provider,
        results: response.results,
        signal: agentAbort.signal,
        onEvent: (agentEvent) => {
          if (agentAbort.signal.aborted) {
            return;
          }
          if (agentEvent.type === 'delta') {
            setAgentStatus((current) => current === 'thinking' ? 'streaming' : current);
            setAnswerText((current) => `${current}${agentEvent.text}`);
            return;
          }
          if (agentEvent.type === 'error') {
            setAgentError(agentEvent.errorMessage);
            setAgentStatus('error');
            return;
          }
          setAgentStatus((current) => current === 'error' ? current : 'done');
        },
      });
    } catch (nextError) {
      if (agentAbort.signal.aborted) {
        return;
      }
      if (!searchCompleted) {
        setResults([]);
        setSearchError(asErrorMessage(nextError));
        setSearchLoading(false);
      } else {
        setAgentError(asErrorMessage(nextError));
        setAgentStatus('error');
      }
    } finally {
      if (agentAbortRef.current === agentAbort) {
        agentAbortRef.current = null;
      }
      setSearchLoading(false);
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

  const showAnswerPane = submitted && provider !== 'none' && !searchError && results.length > 0;
  const qaClassName = showAnswerPane ? 'search-qa-layout' : 'search-qa-layout search-qa-layout-results-only';
  const qaStyle: SearchLayoutStyle | undefined = showAnswerPane
    ? { '--search-answer-ratio': `${splitRatio}%` }
    : undefined;

  return (
    <div
      className={submitted ? 'search-page search-page-submitted' : 'search-page'}
      onPointerDownCapture={(event) => closeMenuOnOutsidePointer(event.nativeEvent)}
      onClickCapture={(event) => closeMenuOnOutsidePointer(event.nativeEvent)}
    >
      {!submitted ? (
        <h1 className="search-prompt-title">
          <img src={muninnLogo} alt="Muninn" />
          <span>recalls everything you worked on</span>
        </h1>
      ) : null}
      <div className={submitted ? 'search-header-row' : 'search-header-row search-header-row-home'}>
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
                    icon={ProviderModelIcon}
                    label="Provider"
                    value={provider}
                    options={providerOptions}
                    open={openMenu === 'provider'}
                    hideLabel
                    onToggle={() => toggleMenu('provider')}
                    onChange={(value) => {
                      setProvider(value);
                      setOpenMenu(null);
                    }}
                  />
                </div>
                <button className="search-submit-button" type="submit" aria-label="Search" disabled={!controls.query.trim() || searchLoading}>
                  <ArrowUp />
                </button>
              </div>
            </div>
            <div className="search-controls" aria-label="Search controls">
              <SearchTopMenu
                icon={TopNIcon}
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
      </div>
      {projectError ? <div className="search-error search-page-error">{projectError}</div> : null}
      {submitted ? (
        <div
          ref={splitLayoutRef}
          className={qaClassName}
          style={qaStyle}
          onPointerDownCapture={() => {
            if (composerExpanded) {
              setComposerExpanded(false);
            }
            if (openMenu) {
              setOpenMenu(null);
            }
          }}
        >
          {showAnswerPane ? (
            <>
              <section className="search-answer-pane" aria-label="Agent answer">
                <SearchAnswerView status={agentStatus} error={agentError} text={answerText} />
              </section>
              <button
                className="search-qa-divider"
                type="button"
                role="separator"
                aria-label="Resize answer and search results"
                aria-orientation="vertical"
                aria-valuemin={MIN_SEARCH_SPLIT_RATIO}
                aria-valuemax={MAX_SEARCH_SPLIT_RATIO}
                aria-valuenow={Math.round(splitRatio)}
                onPointerDown={beginSplitDrag}
                onPointerMove={dragSplit}
                onPointerUp={endSplitDrag}
                onPointerCancel={endSplitDrag}
              />
            </>
          ) : null}
          <section className="search-evidence-pane" aria-label="Search evidence">
            <SearchSourceTabs value={sourceTab} onChange={setSourceTab} />
            <SearchResults
              loading={searchLoading}
              error={searchError}
              results={results}
              expanded={expanded}
              onToggle={(id) => setExpanded((current) => ({ ...current, [id]: !current[id] }))}
            />
          </section>
        </div>
      ) : null}
    </div>
  );
}

function SearchAnswerView({
  status,
  error,
  text,
}: {
  status: AgentRecallStatus;
  error: string | null;
  text: string;
}) {
  if (status === 'thinking') {
    return (
      <div className="search-answer">
        <div className="search-answer-thinking" aria-label="Thinking">
          <span />
          <span />
          <span />
        </div>
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="search-answer">
        <div className="search-answer-error">{error ?? 'I could not complete this question.'}</div>
      </div>
    );
  }
  if (status === 'done' && !text.trim()) {
    return (
      <div className="search-answer">
        <div className="search-answer-empty">No answer generated.</div>
      </div>
    );
  }
  if (!text.trim()) {
    return null;
  }
  return (
    <div className="search-answer">
      <div className="search-answer-text">
        <ReactMarkdown>{text}</ReactMarkdown>
      </div>
    </div>
  );
}

function waitForPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function controlsFromRecallHash(): SearchControlsState {
  const params = recallHashParams();
  const defaults = defaultSearchControls();
  return {
    query: params.get('q') ?? defaults.query,
    projectKeys: params.getAll('project').filter(Boolean),
    sessionKeys: params.getAll('session').filter(Boolean),
    sessionTopN: normalizeSearchN(params.get('sessionTopN') ?? '', defaults.sessionTopN),
    topN: normalizeSearchN(params.get('topN') ?? '', defaults.topN),
  };
}

function providerFromRecallHash(): string {
  return recallHashParams().get('provider') || 'default';
}

function normalizeRecallProvider(provider: string, providers: RecallProviderOption[]): string {
  return providers.some((option) => option.value === provider)
    ? provider
    : providers[0]?.value ?? 'default';
}

function writeRecallHash(controls: SearchControlsState, provider: string) {
  if (!currentHashPath().startsWith('recall')) {
    return;
  }

  const params = new URLSearchParams();
  if (controls.query.trim()) {
    params.set('q', controls.query);
  }
  for (const projectKey of controls.projectKeys) {
    params.append('project', projectKey);
  }
  for (const sessionKey of controls.sessionKeys) {
    params.append('session', sessionKey);
  }
  params.set('topN', String(controls.topN));
  params.set('sessionTopN', String(controls.sessionTopN));
  params.set('provider', provider);

  const query = params.toString();
  const nextHash = query ? `#/recall?${query}` : '#/recall';
  if (window.location.hash === nextHash) {
    return;
  }
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${nextHash}`);
}

function recallHashParams(): URLSearchParams {
  const [, query = ''] = window.location.hash.replace(/^#\/?/, '').split('?');
  return new URLSearchParams(query);
}

function currentHashPath(): string {
  return window.location.hash.replace(/^#\/?/, '').split('?')[0] ?? '';
}

function clampSearchSplitRatio(value: number): number {
  return Math.min(MAX_SEARCH_SPLIT_RATIO, Math.max(MIN_SEARCH_SPLIT_RATIO, value));
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
  icon: SvgIcon;
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
            <span>Total memories</span>
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
            <span>Per session</span>
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
  icon: SvgIcon;
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
    return <div className="search-status">We couldn't find matching context.</div>;
  }
  const projectGroups = groupResultsByProject(results);
  return (
    <div className="search-results">
      {projectGroups.map((project) => (
        <section key={project.key} className="search-project-group">
          <div className="search-project-heading">
            <h2>{project.projectKey}</h2>
            {project.cwds.length > 0 ? (
              <div className="search-project-cwd-menu">
                <button
                  className="search-project-cwd-trigger"
                  type="button"
                  aria-label={`${project.projectKey} working directories`}
                >
                  ...
                </button>
                <div className="search-project-cwd-popover" role="tooltip">
                  {project.cwds.map((cwd) => (
                    <div key={cwd} className="search-project-cwd">{cwd}</div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
          {project.sessions.map((result) => (
            <article key={result.sessionKey} className="search-result">
              <div className="search-result-heading">
                <h3>{result.sessionLabel}</h3>
                <span className="search-result-meta">{memoryCountLabel(result.items.length)}</span>
              </div>
              <div className="search-result-items">
                {result.items.map((item) => {
                  const expandedContent = searchExpandedContent(item.content);
                  const isExpandable = shouldPreview(expandedContent) || (item.references?.length ?? 0) > 0;
                  const isExpanded = Boolean(expanded[item.id]);
                  return (
                    <section key={item.id} className="search-hit">
                      {item.title ? (
                        <div className="search-hit-label-row">
                          <span className="search-hit-label">{item.title}</span>
                        </div>
                      ) : null}
                      <p className="search-hit-snippet">{searchSnippet(item.content)}</p>
                      {isExpandable ? (
                        <button className="search-hit-toggle" type="button" onClick={() => onToggle(item.id)}>
                          {isExpanded ? <ChevronUp /> : <ChevronDown />}
                          <span>{isExpanded ? 'Collapse' : 'Expand'}</span>
                        </button>
                      ) : null}
                      {isExpanded ? (
                        <div className="search-hit-content-box">
                          {item.createdAt ? <div className="search-hit-content-time">{formatHitDateTime(item.createdAt)}</div> : null}
                          <div className="search-hit-content">
                            <ReactMarkdown>{expandedContent}</ReactMarkdown>
                          </div>
                          <SearchTurnReferences references={item.references ?? []} />
                        </div>
                      ) : null}
                    </section>
                  );
                })}
              </div>
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}

type SearchProjectGroup = {
  key: string;
  projectKey: string;
  cwds: string[];
  sessions: SearchSessionResult[];
};

function groupResultsByProject(results: SearchSessionResult[]): SearchProjectGroup[] {
  const groups = new Map<string, SearchProjectGroup>();
  for (const result of results) {
    const cwd = normalizeOptionalText(result.projectCwd);
    const key = result.projectKey;
    const group = groups.get(key) ?? {
      key,
      projectKey: result.projectKey,
      cwds: [],
      sessions: [],
    };
    if (cwd && !group.cwds.includes(cwd)) {
      group.cwds.push(cwd);
    }
    group.sessions.push(result);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function memoryCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'memory' : 'memories'}`;
}

function SearchTurnReferences({ references }: { references: string[] }) {
  const turnReferences = references.filter((reference) => reference.startsWith('turn:'));

  if (turnReferences.length === 0) {
    return null;
  }

  return (
    <div className="search-hit-references">
      <div className="search-hit-references-title">Referenced turns</div>
      <div className="search-hit-reference-list">
        {turnReferences.map((reference) => (
          <a key={reference} href={`#/session/${encodeURIComponent(reference)}`} className="observation-inline-citation search-hit-reference">
            [{turnReferenceLabel(reference)}]
          </a>
        ))}
      </div>
    </div>
  );
}

function shouldPreview(content: string): boolean {
  return content.length > 220 || content.split('\n').length > 3;
}

function searchSnippet(content: string): string {
  const source = markdownSection(content, 'Summary') ?? content;
  const plain = markdownToPlainText(source);
  return truncateSnippet(plain, 260);
}

function searchExpandedContent(content: string): string {
  return markdownSection(content, 'Content') ?? content;
}

function markdownSection(content: string, heading: string): string | null {
  const lines = content.split('\n');
  const section: string[] = [];
  let collecting = false;
  let sectionLevel = 0;
  for (const line of lines) {
    const headingMatch = line.trim().match(/^(#{1,6})\s+(.+?)\s*$/);
    if (headingMatch) {
      const currentLevel = headingMatch[1].length;
      const currentHeading = headingMatch[2].trim();
      if (collecting && currentLevel <= sectionLevel) {
        break;
      }
      if (!collecting && currentHeading.toLowerCase() === heading.toLowerCase()) {
        collecting = true;
        sectionLevel = currentLevel;
        continue;
      }
    }
    if (collecting) {
      section.push(line);
    }
  }
  const value = section.join('\n').trim();
  return value.length > 0 ? value : null;
}

function markdownToPlainText(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, ' ')
    .split('\n')
    .filter((line) => !/^#{1,6}\s+(Title|Summary|Content)\s*$/i.test(line.trim()))
    .join(' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/[`*_>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateSnippet(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  const preview = text.slice(0, limit).trimEnd();
  const lastSpace = preview.lastIndexOf(' ');
  return `${lastSpace > 80 ? preview.slice(0, lastSpace) : preview}...`;
}

function formatHitDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return value;
  }
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  const hour = `${date.getHours()}`.padStart(2, '0');
  const minute = `${date.getMinutes()}`.padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function turnReferenceLabel(reference: string): string {
  return `detail: ${reference.replace(/^turn:/, 'turn ')}`;
}
