import {
  getDemoDocument,
  getDemoObservings,
  getDemoSessionAgents,
  getDemoSessionGroups,
  getDemoSessionTurns,
} from './demo/provider.js';
import { validateSettingsJson } from './server/settings.js';

type Mode = 'session' | 'observing';
type DataMode = 'live' | 'tree' | 'card';

type AgentNode = {
  agent: string;
  latestUpdatedAt: string;
};

type SessionNode = {
  sessionKey: string;
  displaySessionId: string;
  latestUpdatedAt: string;
};

type TurnPreview = {
  memoryId: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
  summary: string;
};

type MemoryReference = {
  memoryId: string;
  timestamp: string;
  summary: string;
};

type ObservingCard = {
  memoryId: string;
  title: string;
  summary: string;
  updatedAt: string;
  references: MemoryReference[];
};

type MemoryDocument = {
  memoryId: string;
  kind: 'session' | 'observing';
  title: string;
  markdown: string;
  agent?: string;
  observer?: string;
  sessionId?: string;
  updatedAt?: string;
};

type SessionAgentsResponse = {
  agents: AgentNode[];
};

type SessionGroupsResponse = {
  sessions: SessionNode[];
};

type SessionTurnsResponse = {
  turns: TurnPreview[];
  nextOffset: number | null;
};

type ObservingListResponse = {
  observations: ObservingCard[];
};

type MemoryDocumentResponse = {
  document: MemoryDocument;
};

type SettingsConfigResponse = {
  pathLabel: string;
  content: string;
};

type ErrorResponse = {
  errorCode: string;
  errorMessage: string;
};

type VersionResponse = {
  version: string;
};

type RouteState = {
  mode: Mode;
  memoryId: string | null;
};

type SessionTurnsState = {
  items: TurnPreview[];
  nextOffset: number | null;
  loading: boolean;
  loaded: boolean;
};

type AppState = {
  apiBase: string;
  dataMode: DataMode;
  route: RouteState;
  leftWidth: number;
  modeMenuOpen: boolean;
  backendVersion: string | null;
  loadingAgents: boolean;
  loadingObservings: boolean;
  loadingDocument: boolean;
  agents: AgentNode[];
  sessionGroups: Record<string, SessionNode[]>;
  sessionTurns: Record<string, SessionTurnsState>;
  observings: ObservingCard[];
  document: MemoryDocument | null;
  documentError: string | null;
  paneError: string | null;
  expandedAgents: Set<string>;
  expandedSessions: Set<string>;
  expandedObservings: Set<string>;
  settingsOpen: boolean;
  settingsLoading: boolean;
  settingsSaving: boolean;
  settingsEditing: boolean;
  settingsPathLabel: string;
  settingsContent: string;
  settingsDraft: string;
  settingsError: string | null;
};

const DEFAULT_API_BASE = 'http://localhost:8080';
const DEFAULT_BACKEND_VERSION = '0.1.0';
const MIN_LEFT_WIDTH = 280;
const MAX_LEFT_WIDTH = 560;
const DEFAULT_LEFT_WIDTH = 360;

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('app container not found');
}

const appRoot = app;

const state: AppState = {
  apiBase: resolveApiBase(),
  route: parseRoute(window.location.hash),
  dataMode: resolveDataMode(),
  leftWidth: restoreLeftWidth(),
  modeMenuOpen: false,
  backendVersion: DEFAULT_BACKEND_VERSION,
  loadingAgents: false,
  loadingObservings: false,
  loadingDocument: false,
  agents: [],
  sessionGroups: {},
  sessionTurns: {},
  observings: [],
  document: null,
  documentError: null,
  paneError: null,
  expandedAgents: new Set(),
  expandedSessions: new Set(),
  expandedObservings: new Set(),
  settingsOpen: false,
  settingsLoading: false,
  settingsSaving: false,
  settingsEditing: false,
  settingsPathLabel: 'settings.json',
  settingsContent: '',
  settingsDraft: '',
  settingsError: null,
};

void bootstrap();

async function bootstrap() {
  bindGlobalEvents();
  void loadBackendVersion();
  await syncRoute(state.route);
}

async function loadBackendVersion() {
  try {
    const response = await fetchJson<VersionResponse>('/version');
    state.backendVersion = response.version;
  } catch {
    state.backendVersion = DEFAULT_BACKEND_VERSION;
  } finally {
    render();
  }
}

function resolveApiBase(): string {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('apiBase');
  if (fromQuery) {
    localStorage.setItem('muninn.board.apiBase', fromQuery);
    return trimTrailingSlash(fromQuery);
  }

  const fromStorage = localStorage.getItem('muninn.board.apiBase');
  if (fromStorage) {
    return trimTrailingSlash(fromStorage);
  }

  if (window.location.pathname.startsWith('/board')) {
    return trimTrailingSlash(window.location.origin);
  }

  if (window.location.port === '8080') {
    return trimTrailingSlash(window.location.origin);
  }

  return DEFAULT_API_BASE;
}

function resolveDataMode(): DataMode {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('demo');
  if (fromQuery === '1') {
    localStorage.setItem('muninn.board.dataMode', 'tree');
    return 'tree';
  }

  if (fromQuery === '0') {
    localStorage.setItem('muninn.board.dataMode', 'live');
    return 'live';
  }

  const stored = localStorage.getItem('muninn.board.dataMode');
  if (stored === 'card') {
    return 'card';
  }
  if (stored === 'tree' || stored === 'demo') {
    return 'tree';
  }
  return 'live';
}

function usesDemoData(mode: DataMode): boolean {
  return mode !== 'live';
}

function restoreLeftWidth(): number {
  const stored = Number(localStorage.getItem('muninn.board.leftWidth'));
  if (Number.isNaN(stored)) {
    return DEFAULT_LEFT_WIDTH;
  }
  return clamp(stored, MIN_LEFT_WIDTH, MAX_LEFT_WIDTH);
}

function bindGlobalEvents() {
  window.addEventListener('hashchange', async () => {
    await syncRoute(parseRoute(window.location.hash));
  });

  window.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-mode-menu-root]')) {
      return;
    }

    if (state.modeMenuOpen) {
      state.modeMenuOpen = false;
      render();
    }
  });
}

function parseRoute(hash: string): RouteState {
  const value = hash.replace(/^#\/?/, '');
  const parts = value.split('/').filter(Boolean);

  if (parts[0] === 'observing') {
    return {
      mode: 'observing',
      memoryId: parts[1] ? decodeURIComponent(parts.slice(1).join('/')) : null,
    };
  }

  return {
    mode: 'session',
    memoryId: parts[1] ? decodeURIComponent(parts.slice(1).join('/')) : null,
  };
}

async function syncRoute(route: RouteState) {
  state.route = route;
  state.documentError = null;

  if (route.mode === 'session') {
    await ensureSessionAgents();
  } else {
    await ensureObservings();
  }

  if (route.memoryId) {
    await loadDocument(route.memoryId);
  } else {
    state.document = null;
    state.documentError = null;
    render();
  }
}

async function ensureSessionAgents() {
  if (state.agents.length > 0 || state.loadingAgents) {
    render();
    return;
  }

  state.loadingAgents = true;
  render();
  try {
    if (usesDemoData(state.dataMode)) {
      state.agents = await getDemoSessionAgents();
    } else {
      const response = await fetchJson<SessionAgentsResponse>('/api/v1/ui/session/agents');
      state.agents = response.agents;
    }
    state.paneError = null;
  } catch (error) {
    state.paneError = asErrorMessage(error);
  } finally {
    state.loadingAgents = false;
    render();
  }
}

async function ensureObservings() {
  if (state.observings.length > 0 || state.loadingObservings) {
    render();
    return;
  }

  state.loadingObservings = true;
  render();
  try {
    if (usesDemoData(state.dataMode)) {
      state.observings = await getDemoObservings();
    } else {
      const response = await fetchJson<ObservingListResponse>('/api/v1/ui/observing');
      state.observings = response.observations;
    }
    state.paneError = null;
  } catch (error) {
    state.paneError = asErrorMessage(error);
  } finally {
    state.loadingObservings = false;
    render();
  }
}

async function ensureSessionGroups(agent: string) {
  if (state.sessionGroups[agent]) {
    return;
  }

  if (usesDemoData(state.dataMode)) {
    state.sessionGroups[agent] = await getDemoSessionGroups(agent);
  } else {
    const response = await fetchJson<SessionGroupsResponse>(
      `/api/v1/ui/session/agents/${encodeURIComponent(agent)}/sessions`,
    );
    state.sessionGroups[agent] = response.sessions;
  }
}

async function ensureSessionTurns(agent: string, sessionKey: string) {
  const key = `${agent}::${sessionKey}`;
  if (state.sessionTurns[key]?.loaded || state.sessionTurns[key]?.loading) {
    return;
  }

  state.sessionTurns[key] = {
    items: [],
    nextOffset: null,
    loading: true,
    loaded: false,
  };
  render();

  try {
    if (usesDemoData(state.dataMode)) {
      const response = await getDemoSessionTurns(agent, sessionKey, 0, 10);
      state.sessionTurns[key] = {
        items: response.turns,
        nextOffset: response.nextOffset,
        loading: false,
        loaded: true,
      };
    } else {
      const response = await fetchJson<SessionTurnsResponse>(
        `/api/v1/ui/session/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(sessionKey)}/turns?offset=0&limit=10`,
      );
      state.sessionTurns[key] = {
        items: response.turns,
        nextOffset: response.nextOffset,
        loading: false,
        loaded: true,
      };
    }
  } catch (error) {
    state.sessionTurns[key] = {
      items: [],
      nextOffset: null,
      loading: false,
      loaded: false,
    };
    state.paneError = asErrorMessage(error);
  } finally {
    render();
  }
}

async function loadMoreTurns(agent: string, sessionKey: string) {
  const key = `${agent}::${sessionKey}`;
  const current = state.sessionTurns[key];
  if (!current || current.loading || current.nextOffset === null) {
    return;
  }

  current.loading = true;
  render();

  try {
    if (usesDemoData(state.dataMode)) {
      const response = await getDemoSessionTurns(agent, sessionKey, current.nextOffset, 10);
      current.items = [...current.items, ...response.turns];
      current.nextOffset = response.nextOffset;
    } else {
      const response = await fetchJson<SessionTurnsResponse>(
        `/api/v1/ui/session/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(sessionKey)}/turns?offset=${current.nextOffset}&limit=10`,
      );
      current.items = [...current.items, ...response.turns];
      current.nextOffset = response.nextOffset;
    }
    state.paneError = null;
  } catch (error) {
    state.paneError = asErrorMessage(error);
  } finally {
    current.loading = false;
    render();
  }
}

async function loadDocument(memoryId: string) {
  state.loadingDocument = true;
  state.documentError = null;
  render();

  try {
    if (usesDemoData(state.dataMode)) {
      state.document = await getDemoDocument(memoryId);
    } else {
      const response = await fetchJson<MemoryDocumentResponse>(
        `/api/v1/ui/memories/${encodeURIComponent(memoryId)}/document`,
      );
      state.document = response.document;
    }
  } catch (error) {
    state.document = null;
    state.documentError = asErrorMessage(error);
  } finally {
    state.loadingDocument = false;
    render();
  }
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${state.apiBase}${path}`);
  if (!response.ok) {
    const body = await safeJson<ErrorResponse>(response);
    const message = body?.errorMessage ?? `${response.status} ${response.statusText}`;
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

async function safeJson<T>(response: Response): Promise<T | null> {
  try {
    return await response.json() as T;
  } catch {
    return null;
  }
}

function render() {
  appRoot.innerHTML = `
    <div class="shell">
      ${renderTopbar()}
      ${renderSettingsModal()}
      <div class="workspace">
        <aside class="left-pane" style="width:${state.leftWidth}px">
          ${renderModeSwitcher()}
          <div class="left-pane-body">
            ${state.route.mode === 'session' ? renderSessionPane() : renderObservingPane()}
          </div>
        </aside>
        <div id="pane-resizer" class="pane-resizer" role="separator" aria-orientation="vertical" aria-label="Resize panes"></div>
        <main class="right-pane">
          ${renderRightPane()}
        </main>
      </div>
    </div>
  `;

  bindViewEvents();
}

function renderTopbar(): string {
  return `
    <header class="topbar">
      <div class="brand-block">
        <div class="brand-mark">M</div>
        <h1 class="topbar-title">Muninn Board</h1>
      </div>
      <div class="topbar-actions">
        <div class="mode-toggle" role="group" aria-label="Data mode">
          <button class="mode-toggle-button ${state.dataMode === 'live' ? 'mode-toggle-button-active' : ''}" data-action="set-data-mode" data-mode="live">Live</button>
          <button class="mode-toggle-button ${state.dataMode === 'tree' ? 'mode-toggle-button-active' : ''}" data-action="set-data-mode" data-mode="tree">Tree</button>
          <button class="mode-toggle-button ${state.dataMode === 'card' ? 'mode-toggle-button-active' : ''}" data-action="set-data-mode" data-mode="card">Card</button>
        </div>
        <button class="topbar-text-action" type="button" data-action="open-settings">Settings</button>
        <a class="topbar-version topbar-action-link" href="https://github.com/majin1102/muninn/releases" target="_blank" rel="noreferrer">Version: ${escapeHtml(state.backendVersion ?? DEFAULT_BACKEND_VERSION)}</a>
        <a class="github-link" href="https://github.com/majin1102/muninn" target="_blank" rel="noreferrer" aria-label="Open GitHub repository">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.67 0 8.2c0 3.63 2.29 6.71 5.47 7.8.4.08.55-.18.55-.4 0-.2-.01-.87-.01-1.58-2.01.38-2.53-.5-2.69-.95-.09-.24-.48-.99-.82-1.19-.28-.16-.68-.56-.01-.57.63-.01 1.08.59 1.23.84.72 1.25 1.87.9 2.33.68.07-.54.28-.9.5-1.11-1.78-.21-3.64-.92-3.64-4.07 0-.9.31-1.64.82-2.22-.08-.21-.36-1.05.08-2.18 0 0 .67-.22 2.2.85.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.07 2.2-.85 2.2-.85.44 1.13.16 1.97.08 2.18.51.58.82 1.31.82 2.22 0 3.16-1.87 3.86-3.65 4.07.29.26.54.75.54 1.52 0 1.1-.01 1.98-.01 2.25 0 .22.15.49.55.4A8.176 8.176 0 0 0 16 8.2C16 3.67 12.42 0 8 0Z"/>
          </svg>
        </a>
      </div>
    </header>
  `;
}

function renderSettingsModal(): string {
  if (!state.settingsOpen) {
    return '';
  }

  const content = state.settingsEditing ? state.settingsDraft : state.settingsContent;
  const actionLabel = state.settingsEditing ? 'Save' : 'Edit';
  const hint = state.settingsEditing
    ? 'Click <span class="settings-inline-token">Save</span> to validate and save the setting file.'
    : 'Click <span class="settings-inline-token">Edit</span> to edit the setting file.';

  return `
    <div class="modal-backdrop" data-action="close-settings">
      <section class="settings-modal" role="dialog" aria-modal="true" aria-label="Settings" data-settings-modal>
        <header class="settings-header">
          <div>
            <h2>Settings</h2>
            <p>${escapeHtml(state.settingsPathLabel)}</p>
          </div>
          <button class="settings-close" type="button" data-action="close-settings" aria-label="Close settings">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3.28 3.22a.75.75 0 0 1 1.06 0L8 6.94l3.66-3.72a.75.75 0 1 1 1.08 1.04L9.06 8l3.68 3.74a.75.75 0 1 1-1.08 1.04L8 9.06l-3.66 3.72a.75.75 0 1 1-1.08-1.04L6.94 8 3.28 4.26a.75.75 0 0 1 0-1.04Z"/>
            </svg>
          </button>
        </header>
        <div class="settings-body ${state.settingsEditing ? 'settings-body-editing' : ''}">
          ${state.settingsLoading ? '<div class="pane-message">Loading settings.json...</div>' : ''}
          ${state.settingsError ? `<div class="pane-message pane-error">${escapeHtml(state.settingsError)}</div>` : ''}
          <textarea
            class="settings-editor"
            ${state.settingsEditing ? '' : 'readonly'}
            spellcheck="false"
            data-role="settings-editor"
          >${escapeHtml(content)}</textarea>
        </div>
        <footer class="settings-footer">
          <span class="settings-hint">${hint}</span>
          <div class="settings-footer-actions">
            ${state.settingsSaving ? '<span class="settings-status">Saving...</span>' : ''}
            <button class="settings-primary-action" type="button" data-action="toggle-settings-edit">${actionLabel}</button>
          </div>
        </footer>
      </section>
    </div>
  `;
}

function renderModeSwitcher(): string {
  const currentLabel = state.route.mode === 'session' ? 'Session' : 'Observing';
  const chevron = state.modeMenuOpen ? '▾' : '▾';
  return `
    <div class="left-pane-header" data-mode-menu-root>
      <button
        class="mode-menu-button"
        type="button"
        aria-haspopup="menu"
        aria-expanded="${state.modeMenuOpen ? 'true' : 'false'}"
        data-action="toggle-mode-menu"
      >
        <span>${currentLabel}</span>
        <span class="mode-menu-chevron ${state.modeMenuOpen ? 'mode-menu-chevron-open' : ''}">${chevron}</span>
      </button>
      ${state.modeMenuOpen ? `
        <div class="mode-menu" role="menu">
          ${renderModeMenuItem('session')}
          ${renderModeMenuItem('observing')}
        </div>
      ` : ''}
    </div>
  `;
}

function renderModeMenuItem(mode: Mode): string {
  const label = mode === 'session' ? 'Session' : 'Observing';
  return `
    <button
      class="mode-menu-item ${state.route.mode === mode ? 'mode-menu-item-active' : ''}"
      type="button"
      role="menuitem"
      data-action="switch-layer"
      data-mode="${mode}"
    >
      ${label}
    </button>
  `;
}

function renderSessionPane(): string {
  if (state.loadingAgents && state.agents.length === 0) {
    return '<div class="pane-message">Loading session tree...</div>';
  }

  if (state.paneError && state.agents.length === 0) {
    return `<div class="pane-message pane-error">${escapeHtml(state.paneError)}</div>`;
  }

  if (state.agents.length === 0) {
    return '<div class="pane-message">No session memories yet.</div>';
  }

  return `
    <div class="tree-root">
      ${state.agents.map((agent) => renderAgentNode(agent)).join('')}
    </div>
  `;
}

function renderAgentNode(agent: AgentNode): string {
  const expanded = state.expandedAgents.has(agent.agent);
  const groups = state.sessionGroups[agent.agent] ?? [];

  return `
    <section class="tree-block">
      <button class="tree-row tree-row-agent" data-action="toggle-agent" data-agent="${escapeAttr(agent.agent)}">
        <span class="tree-row-main">
          <span class="chevron">${expanded ? '▾' : '▸'}</span>
          <span class="tree-label">${escapeHtml(agent.agent)}</span>
        </span>
        <span class="tree-meta">${escapeHtml(formatTimestamp(agent.latestUpdatedAt))}</span>
      </button>
      ${expanded ? `
        <div class="tree-children">
          ${groups.length > 0
            ? groups.map((group) => renderSessionNode(agent.agent, group)).join('')
            : '<div class="pane-message">No sessions.</div>'}
        </div>
      ` : ''}
    </section>
  `;
}

function renderSessionNode(agent: string, session: SessionNode): string {
  const key = `${agent}::${session.sessionKey}`;
  const expanded = state.expandedSessions.has(key);
  const turnsState = state.sessionTurns[key];

  return `
    <section class="tree-block tree-block-session">
      <button
        class="tree-row tree-row-session"
        data-action="toggle-session"
        data-agent="${escapeAttr(agent)}"
        data-session-key="${escapeAttr(session.sessionKey)}"
      >
        <span class="tree-row-main">
          <span class="chevron">${expanded ? '▾' : '▸'}</span>
          <span class="tree-label">${escapeHtml(session.displaySessionId)}</span>
        </span>
        <span class="tree-meta">${escapeHtml(formatTimestamp(session.latestUpdatedAt))}</span>
      </button>
      ${expanded ? renderTimeline(agent, session.sessionKey, turnsState) : ''}
    </section>
  `;
}

function renderTimeline(agent: string, sessionKey: string, turnsState?: SessionTurnsState): string {
  if (!turnsState || (turnsState.loading && turnsState.items.length === 0)) {
    return '<div class="timeline-empty">Loading turns...</div>';
  }

  return `
    <div class="timeline">
      ${turnsState.items.map((item) => `
        <button
          class="timeline-item ${state.route.memoryId === item.memoryId ? 'timeline-item-active' : ''}"
          data-action="open-memory"
          data-memory-id="${escapeAttr(item.memoryId)}"
        >
          <span class="timeline-time">${escapeHtml(formatTime(item.updatedAt))}</span>
          <span class="timeline-rail"><span class="timeline-dot"></span></span>
          <span class="timeline-summary">${escapeHtml(item.summary)}</span>
        </button>
      `).join('')}
      ${turnsState.nextOffset !== null ? `
        <button
          class="timeline-more"
          data-action="load-more"
          data-agent="${escapeAttr(agent)}"
          data-session-key="${escapeAttr(sessionKey)}"
        >
          ${turnsState.loading ? 'Loading...' : 'More'}
        </button>
      ` : ''}
    </div>
  `;
}

function renderObservingPane(): string {
  if (state.loadingObservings && state.observings.length === 0) {
    return '<div class="pane-message">Loading observings...</div>';
  }

  if (state.paneError && state.observings.length === 0) {
    return `<div class="pane-message pane-error">${escapeHtml(state.paneError)}</div>`;
  }

  if (state.observings.length === 0) {
    return `
      <div class="pane-message">
        Observing read model is not available yet.
        <span class="pane-subtle">${usesDemoData(state.dataMode)
          ? 'Tree and Card should always show sample observings here.'
          : 'This pane is ready, but the sidecar currently returns an empty list.'}</span>
      </div>
    `;
  }

  return state.observings.map((observing) => renderObservingBlock(observing)).join('');
}

function renderObservingBlock(observing: ObservingCard): string {
  const expanded = state.expandedObservings.has(observing.memoryId);
  const selected = state.route.memoryId === observing.memoryId;

  return `
    <article class="observation-block ${selected ? 'observation-block-active' : ''}">
      <button
        class="observation-open"
        data-action="open-memory"
        data-memory-id="${escapeAttr(observing.memoryId)}"
      >
        <div class="observation-date">${escapeHtml(formatTimestamp(observing.updatedAt))}</div>
        <h3>${escapeHtml(observing.title)}</h3>
        <p>${escapeHtml(expanded ? observing.summary : truncate(observing.summary, 180))}</p>
      </button>
      <div class="observation-actions">
        <button
          class="observation-toggle"
          data-action="toggle-observation"
          data-memory-id="${escapeAttr(observing.memoryId)}"
        >${expanded ? 'Collapse' : 'Expand'}</button>
      </div>
      ${expanded ? `
        <div class="observation-references">
          ${observing.references.length > 0 ? `
            ${observing.references.map((reference) => `
              <button
                class="timeline-item"
                data-action="open-memory"
                data-memory-id="${escapeAttr(reference.memoryId)}"
              >
                <span class="timeline-time">${escapeHtml(formatTime(reference.timestamp))}</span>
                <span class="timeline-rail"><span class="timeline-dot"></span></span>
                <span class="timeline-summary">${escapeHtml(reference.summary)}</span>
              </button>
            `).join('')}
          ` : '<div class="timeline-empty">No references.</div>'}
        </div>
      ` : ''}
    </article>
  `;
}

function renderRightPane(): string {
  if (state.loadingDocument) {
    return '<div class="detail-empty">Loading document...</div>';
  }

  if (state.documentError) {
    return `<div class="detail-empty detail-error">${escapeHtml(state.documentError)}</div>`;
  }

  if (!state.document) {
    return `
      <div class="detail-empty">
        <h2>No memory selected</h2>
        <p>Choose a session memory or observing memory from the left pane to inspect its document.</p>
      </div>
    `;
  }

  return `
    <div class="document-layout">
      ${renderBreadcrumb(state.document)}
      <section class="document-shell">
        <header class="document-header">
          <div>
            <h2>${escapeHtml(state.document.title)}</h2>
          </div>
          <div class="document-actions">
            <button class="document-icon-button" type="button" disabled aria-label="Edit document">
              <span>Edit</span>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M11.6 1.2a1.7 1.7 0 0 1 2.4 2.4L6 11.6 2.5 12.5l.9-3.5 8.2-7.8Zm1.3 1.1a.7.7 0 0 0-1 0l-1 1 1.1 1.1 1-1a.7.7 0 0 0 0-1ZM9.3 5.1 4.2 10l-.3 1.2 1.2-.3 5.1-4.9-1-1Z"/>
              </svg>
            </button>
          </div>
        </header>
        <article class="markdown-doc">
          ${renderMarkdown(state.document.markdown)}
        </article>
      </section>
    </div>
  `;
}

function renderBreadcrumb(document: MemoryDocument): string {
  const items: string[] = [];
  if (state.route.mode === 'session') {
    if (document.agent) {
      items.push(`<span>${escapeHtml(document.agent)}</span>`);
    }
    if (document.observer) {
      items.push(`<span>${escapeHtml(document.observer)}</span>`);
    }
    if (document.sessionId) {
      items.push(`<span>${escapeHtml(document.sessionId)}</span>`);
    }
  } else {
    items.push('<span>Observing</span>');
    if (document.observer) {
      items.push(`<span>${escapeHtml(document.observer)}</span>`);
    }
  }
  items.push(`<span>${escapeHtml(document.memoryId)}</span>`);

  return `
    <nav class="breadcrumb" aria-label="breadcrumb">
      ${items.join('<span class="breadcrumb-sep">&gt;</span>')}
    </nav>
  `;
}

function bindViewEvents() {
  document.querySelector<HTMLElement>('[data-action="open-settings"]')?.addEventListener('click', async () => {
    await openSettings();
  });

  document.querySelector<HTMLElement>('.modal-backdrop[data-action="close-settings"]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) {
      closeSettings();
    }
  });

  document.querySelector<HTMLElement>('.settings-header [data-action="close-settings"]')?.addEventListener('click', () => {
    closeSettings();
  });

  document.querySelector<HTMLElement>('[data-action="toggle-settings-edit"]')?.addEventListener('click', async () => {
    if (state.settingsEditing) {
      await saveSettings();
    } else {
      state.settingsEditing = true;
      state.settingsDraft = state.settingsContent;
      state.settingsError = null;
      render();
    }
  });

  document.querySelector<HTMLTextAreaElement>('[data-role="settings-editor"]')?.addEventListener('input', (event) => {
    if (!(event.target instanceof HTMLTextAreaElement)) {
      return;
    }
    state.settingsDraft = event.target.value;
  });

  document.querySelector<HTMLElement>('[data-action="toggle-mode-menu"]')?.addEventListener('click', (event) => {
    event.stopPropagation();
    state.modeMenuOpen = !state.modeMenuOpen;
    render();
  });

  document.querySelectorAll<HTMLElement>('[data-action="switch-layer"]').forEach((element) => {
    element.addEventListener('click', () => {
      const value = element.dataset.mode as Mode | undefined;
      if (!value) {
        return;
      }

      state.modeMenuOpen = false;
      window.location.hash = value === 'session' ? '#/session' : '#/observing';
    });
  });

  document.querySelectorAll<HTMLElement>('[data-action="set-data-mode"]').forEach((element) => {
    element.addEventListener('click', async () => {
      const mode = element.dataset.mode as DataMode | undefined;
      if (!mode || mode === state.dataMode) {
        return;
      }

      state.dataMode = mode;
      localStorage.setItem('muninn.board.dataMode', mode);
      state.agents = [];
      state.sessionGroups = {};
      state.sessionTurns = {};
      state.observings = [];
      state.document = null;
      state.documentError = null;
      state.paneError = null;
      state.expandedAgents.clear();
      state.expandedSessions.clear();
      state.expandedObservings.clear();

      const url = new URL(window.location.href);
      if (usesDemoData(mode)) {
        url.searchParams.set('demo', '1');
      } else {
        url.searchParams.delete('demo');
      }
      window.history.replaceState({}, '', url.toString());

      await syncRoute(state.route);
    });
  });

  document.querySelectorAll<HTMLElement>('[data-action="toggle-agent"]').forEach((element) => {
    element.addEventListener('click', async () => {
      const agent = element.dataset.agent;
      if (!agent) {
        return;
      }

      if (state.expandedAgents.has(agent)) {
        state.expandedAgents.delete(agent);
        render();
        return;
      }

      state.expandedAgents.add(agent);
      render();
      try {
        await ensureSessionGroups(agent);
        state.paneError = null;
      } catch (error) {
        state.paneError = asErrorMessage(error);
      } finally {
        render();
      }
    });
  });

  document.querySelectorAll<HTMLElement>('[data-action="toggle-session"]').forEach((element) => {
    element.addEventListener('click', async () => {
      const agent = element.dataset.agent;
      const sessionKey = element.dataset.sessionKey;
      if (!agent || !sessionKey) {
        return;
      }

      const key = `${agent}::${sessionKey}`;
      if (state.expandedSessions.has(key)) {
        state.expandedSessions.delete(key);
        render();
        return;
      }

      state.expandedSessions.add(key);
      render();
      await ensureSessionTurns(agent, sessionKey);
    });
  });

  document.querySelectorAll<HTMLElement>('[data-action="open-memory"]').forEach((element) => {
    element.addEventListener('click', () => {
      const memoryId = element.dataset.memoryId;
      if (!memoryId) {
        return;
      }

      const mode = state.route.mode;
      window.location.hash = mode === 'session'
        ? `#/session/${encodeURIComponent(memoryId)}`
        : `#/observing/${encodeURIComponent(memoryId)}`;
    });
  });

  document.querySelectorAll<HTMLElement>('[data-action="load-more"]').forEach((element) => {
    element.addEventListener('click', async () => {
      const agent = element.dataset.agent;
      const sessionKey = element.dataset.sessionKey;
      if (!agent || !sessionKey) {
        return;
      }
      await loadMoreTurns(agent, sessionKey);
    });
  });

  document.querySelectorAll<HTMLElement>('[data-action="toggle-observation"]').forEach((element) => {
    element.addEventListener('click', () => {
      const memoryId = element.dataset.memoryId;
      if (!memoryId) {
        return;
      }

      if (state.expandedObservings.has(memoryId)) {
        state.expandedObservings.delete(memoryId);
      } else {
        state.expandedObservings.add(memoryId);
      }
      render();
    });
  });

  bindResizer();
}

async function openSettings() {
  state.settingsOpen = true;
  state.settingsError = null;
  render();

  if (state.settingsContent || state.settingsLoading) {
    return;
  }

  await loadSettingsConfig();
}

function closeSettings() {
  state.settingsOpen = false;
  state.settingsEditing = false;
  state.settingsError = null;
  render();
}

async function loadSettingsConfig() {
  try {
    state.settingsLoading = true;
    state.settingsError = null;
    render();

    const response = await fetchJson<SettingsConfigResponse>('/api/v1/ui/settings/config');
    validateSettingsJson(response.content);
    state.settingsPathLabel = response.pathLabel;
    state.settingsContent = response.content;
    state.settingsDraft = response.content;
    state.settingsEditing = false;
  } catch (error) {
    state.settingsError = asErrorMessage(error);
  } finally {
    state.settingsLoading = false;
    render();
  }
}

async function saveSettings() {
  try {
    validateSettingsJson(state.settingsDraft);
    state.settingsSaving = true;
    state.settingsError = null;
    render();

    const response = await fetch(`${state.apiBase}/api/v1/ui/settings/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: state.settingsDraft }),
    });

    if (!response.ok) {
      const body = await safeJson<ErrorResponse>(response);
      throw new Error(body?.errorMessage ?? `${response.status} ${response.statusText}`);
    }

    const updated = await response.json() as SettingsConfigResponse;
    state.settingsPathLabel = updated.pathLabel;
    state.settingsContent = updated.content;
    state.settingsDraft = updated.content;
    state.settingsEditing = false;
  } catch (error) {
    state.settingsError = asErrorMessage(error);
  } finally {
    state.settingsSaving = false;
    render();
  }
}

function bindResizer() {
  const resizer = document.querySelector<HTMLElement>('#pane-resizer');
  if (!resizer) {
    return;
  }

  resizer.onmousedown = (event: MouseEvent) => {
    event.preventDefault();

    const onMove = (moveEvent: MouseEvent) => {
      state.leftWidth = clamp(moveEvent.clientX, MIN_LEFT_WIDTH, MAX_LEFT_WIDTH);
      localStorage.setItem('muninn.board.leftWidth', String(state.leftWidth));
      render();
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
}

function renderMarkdown(markdown: string): string {
  const lines = markdown.split('\n');
  const chunks: string[] = [];
  let listItems: string[] = [];
  let paragraphLines: string[] = [];

  function flushList() {
    if (listItems.length === 0) {
      return;
    }
    chunks.push(`<ul>${listItems.join('')}</ul>`);
    listItems = [];
  }

  function flushParagraph() {
    if (paragraphLines.length === 0) {
      return;
    }
    chunks.push(`<p>${escapeHtml(paragraphLines.join(' '))}</p>`);
    paragraphLines = [];
  }

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (!trimmed) {
      flushList();
      flushParagraph();
      continue;
    }

    if (trimmed.startsWith('# ')) {
      flushList();
      flushParagraph();
      chunks.push(`<h1>${escapeHtml(trimmed.slice(2))}</h1>`);
      continue;
    }

    if (trimmed.startsWith('## ')) {
      flushList();
      flushParagraph();
      chunks.push(`<h2>${escapeHtml(trimmed.slice(3))}</h2>`);
      continue;
    }

    if (trimmed.startsWith('- ')) {
      flushParagraph();
      listItems.push(`<li>${escapeHtml(trimmed.slice(2))}</li>`);
      continue;
    }

    flushList();
    paragraphLines.push(trimmed);
  }

  flushList();
  flushParagraph();

  return chunks.join('');
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatTime(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength).trim()}...` : value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll('"', '&quot;');
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
