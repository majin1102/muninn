import type {
  AgentNode,
  CodexImportPreviewResponse,
  CodexImportRunResponse,
  DeleteImportedProjectResponse,
  ImportLocalProjectsResponse,
  ImportProjectsResponse,
  ImportSelectedResponse,
  ImportSessionsListResponse,
  ImportedProjectsResponse,
  ErrorResponse,
  MemoryDocument,
  MemoryDocumentResponse,
  PipelineTasksResponse,
  ProjectDreamProjectView,
  ProjectDreamProjectsResponse,
  ProjectDreamView,
  ProjectDreamViewResponse,
  RecallProvidersResponse,
  SearchResponse,
  AgentRecallStreamEvent,
  SessionAgentsResponse,
  SessionGroupsResponse,
  SessionTurnDetailResponse,
  SessionNode,
  SessionSegmentPreview,
  SessionTimelineItem,
  SessionTurnsResponse,
  SettingsConfigResponse,
  TurnPreview,
} from '@muninn/common';
import {
  getDemoDocument,
  getDemoPipelineTasks,
  getDemoImportSessions,
  getDemoImportedProjects,
  getDemoSearchResults,
  getDemoRecallProviders,
  importDemoProjects,
  importDemoSessionsByPaths,
  deleteDemoImportedProject,
  setDemoAgentCapturePolicy,
  setDemoCapturePolicy,
  streamDemoAgentRecall,
  getDemoSessionAgents,
  getDemoSessionGroups,
  getDemoSessionTurns,
} from '../demo/provider.js';
import { projectDisplayLabel, projectDisplayLabels } from './project-display.js';
import { sampleSettingsDraft, settingsDraftToJson } from './settings-model.js';
import { trimTrailingSlash } from './utils.js';

export type PrimaryView = 'recall' | 'wiki' | 'session' | 'pipelines' | 'settings';

export type ProjectTurnNode = TurnPreview & {
  agent: string;
  sessionKey: string;
  sessionLabel: string;
};

export type ProjectSegmentNode = SessionSegmentPreview & {
  agent: string;
  sessionKey: string;
  sessionLabel: string;
};

export type ProjectTimelineNode = SessionTimelineItem & {
  agent: string;
  sessionKey: string;
  sessionLabel: string;
};

export type ProjectSessionNode = SessionNode & {
  kind: 'session' | 'dreaming';
  agent: string;
  turns: ProjectTurnNode[];
  segments: ProjectSegmentNode[];
  timeline: ProjectTimelineNode[];
  nextOffset: number | null;
  loading: boolean;
  loaded: boolean;
};

export type ProjectNode = {
  projectKey: string;
  label: string;
  latestUpdatedAt: string;
  sessions: ProjectSessionNode[];
};

export type AppClient = {
  apiBase: string;
  usesDemoData: boolean;
  getVersion(): Promise<string>;
  getProjects(): Promise<ProjectNode[]>;
  listProjectDreamProjects(): Promise<ProjectDreamProjectView[]>;
  getProjectDream(project: string): Promise<ProjectDreamView>;
  loadSessionTurns(session: ProjectSessionNode, offset?: number): Promise<{
    turns: ProjectTurnNode[];
    segments: ProjectSegmentNode[];
    timeline: ProjectTimelineNode[];
    nextOffset: number | null;
  }>;
  loadTurnDetail(session: ProjectSessionNode, memoryId: string): Promise<ProjectTurnNode>;
  getDocument(memoryId: string): Promise<MemoryDocument>;
  searchRecall(params: {
    query: string;
    projectKeys?: string[];
    sessionKeys?: string[];
    sessionTopN: number;
    topN: number;
    signal?: AbortSignal;
  }): Promise<SearchResponse>;
  getRecallProviders(): Promise<RecallProvidersResponse>;
  streamAgentRecall(params: {
    query: string;
    provider: string;
    results: SearchResponse['results'];
    signal?: AbortSignal;
    onEvent: (event: AgentRecallStreamEvent) => void;
  }): Promise<void>;
  getSettingsConfig(): Promise<SettingsConfigResponse>;
  getPipelineTasks(): Promise<PipelineTasksResponse>;
  saveSettingsConfig(content: string): Promise<SettingsConfigResponse>;
  previewCodexImport(projectLimit?: number, projectKeys?: string[]): Promise<CodexImportPreviewResponse>;
  importCodexSessions(projectLimit?: number, projectKeys?: string[]): Promise<CodexImportRunResponse>;
  listImportedProjects(): Promise<ImportedProjectsResponse>;
  listLocalProjects(agent: string): Promise<ImportLocalProjectsResponse>;
  listImportSessions(agent: string, scope?: 'imported', project?: string): Promise<ImportSessionsListResponse>;
  importProjects(agent: string, projects: string[]): Promise<ImportProjectsResponse>;
  importSessionsByPaths(agent: string, sourcePaths: string[]): Promise<ImportSelectedResponse>;
  deleteImportedProject(agent: string, project: string): Promise<DeleteImportedProjectResponse>;
  setAgentCapturePolicy(agent: string, enabled: boolean): Promise<void>;
  setCapturePolicy(agent: string, project: string, enabled: boolean): Promise<void>;
};

export const PROJECT_DREAMING_PROJECT_KEY = '.dreaming';
export const PROJECT_DREAMING_SESSION_KEY = '.dreaming';
export const PROJECT_DREAMING_AGENT = 'dreaming';

type VersionResponse = {
  version: string;
};

export const DEFAULT_BACKEND_VERSION = '0.1.0';
const SESSION_TURN_PAGE_SIZE = 16;

function desktopBootstrap(): MuninnDesktopBootstrap | undefined {
  return window.__MUNINN_DESKTOP__;
}

export function resolveApiBase(): string {
  const desktop = desktopBootstrap();
  if (desktop?.apiBase) {
    return trimTrailingSlash(desktop.apiBase);
  }

  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('apiBase');
  if (fromQuery) {
    localStorage.setItem('muninn.web.apiBase', trimTrailingSlash(fromQuery));
    return trimTrailingSlash(fromQuery);
  }

  const fromStorage = localStorage.getItem('muninn.web.apiBase');
  if (fromStorage) {
    return trimTrailingSlash(fromStorage);
  }

  if (window.location.pathname.startsWith('/app') || window.location.port === '8080') {
    return trimTrailingSlash(window.location.origin);
  }

  if (window.location.hostname) {
    return `${window.location.protocol}//${window.location.hostname}:8080`;
  }

  return 'http://127.0.0.1:8080';
}

export function resolveUsesDemoData(): boolean {
  localStorage.removeItem('muninn.web.dataMode');
  return /(?:[?&#])demo=1(?:[&#]|$)/.test(window.location.href);
}

export function createAppClient(apiBase: string, usesDemoData: boolean): AppClient {
  function withDesktopAuth(init?: RequestInit): RequestInit | undefined {
    const token = desktopBootstrap()?.apiToken;
    if (!token) {
      return init;
    }

    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return {
      ...init,
      headers,
    };
  }

  async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${apiBase}${path}`, withDesktopAuth(init));
    if (!response.ok) {
      const body = await safeJson<ErrorResponse>(response);
      throw new Error(body?.errorMessage ?? `${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  }

  async function fetchVoid(path: string, init?: RequestInit): Promise<void> {
    const response = await fetch(`${apiBase}${path}`, withDesktopAuth(init));
    if (!response.ok) {
      const body = await safeJson<ErrorResponse>(response);
      throw new Error(body?.errorMessage ?? `${response.status} ${response.statusText}`);
    }
  }

  async function loadProjectDreamProjects(): Promise<ProjectDreamProjectView[]> {
    if (usesDemoData) {
      return [];
    }
    const response = await fetchJson<ProjectDreamProjectsResponse>('/app/api/dreaming/projects');
    return response.projects;
  }

  return {
    apiBase,
    usesDemoData,
    async getVersion() {
      try {
        const response = await fetchJson<VersionResponse>('/version');
        return response.version;
      } catch {
        return DEFAULT_BACKEND_VERSION;
      }
    },
    async getProjects() {
      const agents = usesDemoData
        ? await getDemoSessionAgents()
        : (await fetchJson<SessionAgentsResponse>('/app/api/session/agents')).agents;
      const dreamProjects = await loadProjectDreamProjects();
      const projects = await projectTreeFromAgents(agents, async (agent) => {
        return usesDemoData
          ? await getDemoSessionGroups(agent)
          : (await fetchJson<SessionGroupsResponse>(
            `/app/api/session/agents/${encodeURIComponent(agent)}/sessions`,
          )).sessions;
      }, dreamProjects);
      if (!usesDemoData) {
        return projects;
      }

      return Promise.all(projects.map(async (project) => ({
        ...project,
        sessions: await Promise.all(project.sessions.map(async (session) => {
          if (isProjectDreamingSession(session)) {
            return session;
          }
          const response = await getDemoSessionTurns(session.agent, session.sessionKey, 0, 20);
          return {
            ...session,
            turns: response.turns.map((turn) => ({
              ...turn,
              agent: session.agent,
              sessionKey: session.sessionKey,
              sessionLabel: session.displaySessionId,
            })),
            segments: (response.segments ?? []).map((segment) => ({
              ...segment,
              agent: session.agent,
              sessionKey: session.sessionKey,
              sessionLabel: session.displaySessionId,
            })),
            timeline: response.timeline.map((item) => ({
              ...item,
              agent: session.agent,
              sessionKey: session.sessionKey,
              sessionLabel: session.displaySessionId,
            })),
            nextOffset: response.nextOffset,
            loaded: true,
          };
        })),
      })));
    },
    async listProjectDreamProjects() {
      return loadProjectDreamProjects();
    },
    async getProjectDream(project) {
      if (usesDemoData) {
        return emptyProjectDream(project);
      }
      const params = new URLSearchParams({ project });
      const response = await fetchJson<ProjectDreamViewResponse>(
        `/app/api/dreaming/project?${params.toString()}`,
      );
      return response.dream;
    },
    async loadSessionTurns(session, offset = 0) {
      const params = new URLSearchParams({
        offset: String(offset),
        limit: String(SESSION_TURN_PAGE_SIZE),
      });
      params.set('project', session.projectKey);
      const response = usesDemoData
        ? await getDemoSessionTurns(session.agent, session.sessionKey, offset, 100)
        : await fetchJson<SessionTurnsResponse>(
          `/app/api/session/agents/${encodeURIComponent(session.agent)}/sessions/${encodeURIComponent(session.sessionKey)}/turns?${params.toString()}`,
        );
      return {
        turns: response.turns.map((turn) => ({
          ...turn,
          agent: session.agent,
          sessionKey: session.sessionKey,
          sessionLabel: session.displaySessionId,
        })),
        segments: (response.segments ?? []).map((segment) => ({
          ...segment,
          agent: session.agent,
          sessionKey: session.sessionKey,
          sessionLabel: session.displaySessionId,
        })),
        timeline: response.timeline.map((item) => ({
          ...item,
          agent: session.agent,
          sessionKey: session.sessionKey,
          sessionLabel: session.displaySessionId,
        })),
        nextOffset: response.nextOffset,
      };
    },
    async loadTurnDetail(session, memoryId) {
      if (usesDemoData) {
        const response = await getDemoSessionTurns(session.agent, session.sessionKey, 0, 1_000);
        const turn = response.turns.find((item) => item.memoryId === memoryId);
        if (!turn) {
          throw new Error('turnId not found');
        }
        return {
          ...turn,
          agent: session.agent,
          sessionKey: session.sessionKey,
          sessionLabel: session.displaySessionId,
        };
      }
      const response = await fetchJson<SessionTurnDetailResponse>(
        `/app/api/session/turns/${encodeURIComponent(memoryId)}/detail`,
      );
      return {
        ...response.turn,
        agent: session.agent,
        sessionKey: session.sessionKey,
        sessionLabel: session.displaySessionId,
      };
    },
    async getDocument(memoryId) {
      if (usesDemoData) {
        return getDemoDocument(memoryId);
      }
      const response = await fetchJson<MemoryDocumentResponse>(
        `/app/api/memories/${encodeURIComponent(memoryId)}/document`,
      );
      return response.document;
    },
    async searchRecall(params) {
      const searchParams = new URLSearchParams({
        query: params.query,
        sessionTopN: String(params.sessionTopN),
        topN: String(params.topN),
      });
      for (const projectKey of params.projectKeys ?? []) {
        searchParams.append('projectKey', projectKey);
      }
      for (const sessionKey of params.sessionKeys ?? []) {
        searchParams.append('sessionKey', sessionKey);
      }
      if (usesDemoData) {
        const results = await getDemoSearchResults(params);
        if (params.signal?.aborted) {
          throw new DOMException('Search aborted', 'AbortError');
        }
        return {
          results,
          requestId: 'demo-search',
        };
      }
      return fetchJson<SearchResponse>(`/app/api/recall/search?${searchParams.toString()}`, { signal: params.signal });
    },
    async getRecallProviders() {
      if (usesDemoData) {
        return getDemoRecallProviders();
      }
      return fetchJson<RecallProvidersResponse>('/app/api/recall/providers');
    },
    async streamAgentRecall(params) {
      if (usesDemoData) {
        for await (const event of streamDemoAgentRecall(params.query, params.results)) {
          if (params.signal?.aborted) {
            return;
          }
          params.onEvent(event);
        }
        return;
      }
      const response = await fetch(`${apiBase}/app/api/recall/agent`, withDesktopAuth({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: params.signal,
        body: JSON.stringify({
          query: params.query,
          provider: params.provider,
          results: params.results,
        }),
      }));
      if (!response.ok) {
        const body = await safeJson<ErrorResponse>(response);
        throw new Error(body?.errorMessage ?? `${response.status} ${response.statusText}`);
      }
      await readAgentRecallStream(response, params.onEvent, params.signal);
    },
    getSettingsConfig() {
      if (usesDemoData) {
        return demoSettingsConfig();
      }
      return fetchJson<SettingsConfigResponse>('/app/api/settings/config');
    },
    getPipelineTasks() {
      return getDemoPipelineTasks();
    },
    saveSettingsConfig(content) {
      if (usesDemoData) {
        return Promise.resolve({
          pathLabel: '~/.muninn/muninn.json',
          content,
          requestId: 'demo-settings-save',
        });
      }
      return fetchJson<SettingsConfigResponse>('/app/api/settings/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      });
    },
    previewCodexImport(projectLimit = 5, projectKeys = []) {
      if (usesDemoData) {
        return demoPreviewImport(projectLimit, projectKeys);
      }
      const params = new URLSearchParams({ projectLimit: String(projectLimit) });
      for (const projectKey of projectKeys) {
        params.append('projectKey', projectKey);
      }
      return fetchJson<CodexImportPreviewResponse>(`/app/api/import/codex/preview?${params.toString()}`);
    },
    importCodexSessions(projectLimit = 5, projectKeys = []) {
      if (usesDemoData) {
        return demoRunCodexImport(projectLimit, projectKeys);
      }
      return fetchJson<CodexImportRunResponse>('/app/api/import/codex', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectLimit, projectKeys }),
      });
    },
    listImportedProjects() {
      if (usesDemoData) {
        return getDemoImportedProjects();
      }
      return fetchJson<ImportedProjectsResponse>('/app/api/import/projects');
    },
    async listLocalProjects(agent) {
      if (usesDemoData) {
        const response = await getDemoImportSessions(agent);
        const projects = response.projects.map((project) => ({
          project: project.project,
          latestUpdatedAt: project.sessions[0]?.updatedAt ?? '',
        }));
        return {
          sourceRoot: response.sourceRoot,
          projectCount: projects.length,
          projects,
          requestId: response.requestId,
        };
      }
      return fetchJson<ImportLocalProjectsResponse>(`/app/api/import/${agent}/local-projects`);
    },
    listImportSessions(agent, scope, project) {
      if (usesDemoData) {
        return getDemoImportSessions(agent, scope);
      }
      const params = new URLSearchParams();
      if (scope) {
        params.set('scope', scope);
      }
      if (project) {
        params.set('project', project);
      }
      const suffix = params.size > 0 ? `?${params.toString()}` : '';
      return fetchJson<ImportSessionsListResponse>(`/app/api/import/${agent}/sessions${suffix}`);
    },
    importProjects(agent, projects) {
      if (usesDemoData) {
        return importDemoProjects(agent, projects);
      }
      return fetchJson<ImportProjectsResponse>(`/app/api/import/${agent}/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projects }),
      });
    },
    importSessionsByPaths(agent, sourcePaths) {
      if (usesDemoData) {
        return importDemoSessionsByPaths(agent, sourcePaths);
      }
      return fetchJson<ImportSelectedResponse>(`/app/api/import/${agent}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourcePaths }),
      });
    },
    deleteImportedProject(agent, project) {
      if (usesDemoData) {
        return deleteDemoImportedProject(agent, project);
      }
      return fetchJson<DeleteImportedProjectResponse>(`/app/api/import/${agent}/project`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project }),
      });
    },
    async setAgentCapturePolicy(agent, enabled) {
      if (usesDemoData) {
        await setDemoAgentCapturePolicy(agent, enabled);
        return;
      }
      await fetchVoid(`/app/api/import/${agent}/agent-capture`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
    },
    async setCapturePolicy(agent, project, enabled) {
      if (usesDemoData) {
        await setDemoCapturePolicy(agent, project, enabled);
        return;
      }
      await fetchVoid(`/app/api/import/${agent}/capture-policy`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project, enabled }),
      });
    },
  };
}

function demoSettingsConfig(): Promise<SettingsConfigResponse> {
  return Promise.resolve({
    pathLabel: '~/.muninn/muninn.json',
    content: settingsDraftToJson(sampleSettingsDraft()),
    requestId: 'demo-settings-config',
  });
}

async function demoPreviewImport(projectLimit: number, projectKeys: string[]): Promise<CodexImportPreviewResponse> {
  const imported = await getDemoImportSessions('codex', 'imported');
  const allowed = new Set(projectKeys);
  const projects = imported.projects
    .filter((project) => allowed.size === 0 || allowed.has(project.project))
    .slice(0, projectLimit)
    .map((project) => ({
      projectKey: project.project,
      cwd: project.project,
      sessions: project.sessions.map((session) => ({
        ...session,
        sourcePath: session.sourcePath ?? '',
        cwd: project.project,
        turnCount: session.turnCount ?? 0,
        artifactCount: session.artifactCount ?? 0,
      })),
    }));
  return {
    sourceRoot: imported.sourceRoot,
    projectLimit,
    projectCount: projects.length,
    sessionCount: projects.reduce((total, project) => total + project.sessions.length, 0),
    turnCount: projects.reduce((total, project) => total + project.sessions.reduce((sum, session) => sum + session.turnCount, 0), 0),
    artifactCount: projects.reduce((total, project) => total + project.sessions.reduce((sum, session) => sum + session.artifactCount, 0), 0),
    projects,
    requestId: 'demo-codex-preview',
  };
}

async function demoRunCodexImport(projectLimit: number, projectKeys: string[]): Promise<CodexImportRunResponse> {
  const preview = await demoPreviewImport(projectLimit, projectKeys);
  return {
    ...preview,
    deletedTurns: 0,
    importedSessions: preview.sessionCount,
    importedTurns: preview.turnCount,
    skippedTurns: 0,
    failedSessions: [],
  };
}

async function readAgentRecallStream(
  response: Response,
  onEvent: (event: AgentRecallStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return;
  }
  if (!response.body) {
    parseAgentRecallLines(await response.text(), onEvent, signal);
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (signal?.aborted) {
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      parseAgentRecallLines(lines.join('\n'), onEvent, signal);
    }
    buffer += decoder.decode();
    parseAgentRecallLines(buffer, onEvent, signal);
  } finally {
    reader.releaseLock();
  }
}

function parseAgentRecallLines(
  raw: string,
  onEvent: (event: AgentRecallStreamEvent) => void,
  signal?: AbortSignal,
) {
  for (const line of raw.split('\n')) {
    if (signal?.aborted) {
      return;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    onEvent(JSON.parse(trimmed) as AgentRecallStreamEvent);
  }
}

async function projectTreeFromAgents(
  agents: AgentNode[],
  getSessions: (agent: string) => Promise<SessionNode[]>,
  dreamProjects: ProjectDreamProjectView[] = [],
): Promise<ProjectNode[]> {
  const projects = new Map<string, ProjectNode>();

  for (const agent of agents) {
    const sessions = await getSessions(agent.agent);
    for (const session of sessions) {
      const projectKey = projectKeyFromSession(session);
      const project = projects.get(projectKey) ?? {
        projectKey,
        label: projectKey,
        latestUpdatedAt: session.latestUpdatedAt,
        sessions: [],
      };

      if (session.latestUpdatedAt > project.latestUpdatedAt) {
        project.latestUpdatedAt = session.latestUpdatedAt;
      }
      project.sessions.push({
        ...session,
        kind: 'session',
        agent: agent.agent,
        turns: [],
        segments: [],
        timeline: [],
        nextOffset: null,
        loading: false,
        loaded: false,
      });
      projects.set(projectKey, project);
    }
  }

  const projectList = [...projects.values()]
    .map((project) => ({
      ...project,
      sessions: project.sessions.sort((left, right) => left.latestUpdatedAt.localeCompare(right.latestUpdatedAt)),
    }))
    .sort((left, right) => left.latestUpdatedAt.localeCompare(right.latestUpdatedAt));
  const labels = projectDisplayLabels([
    ...projectList.map((project) => project.projectKey),
    ...dreamProjects.map((project) => project.project),
  ]);

  const labeledProjects = projectList.map((project) => ({
    ...project,
    label: labels.get(project.projectKey) ?? projectDisplayLabel(project.projectKey),
  }));
  const dreamingProject = createProjectDreamingProject(dreamProjects, labels);
  return dreamingProject ? [dreamingProject, ...labeledProjects] : labeledProjects;
}

function createProjectDreamingProject(
  dreamProjects: ProjectDreamProjectView[],
  labels: Map<string, string>,
): ProjectNode | null {
  if (dreamProjects.length === 0) {
    return null;
  }
  const sessions = dreamProjects
    .map((project) => createProjectDreamingSession(project, labels.get(project.project) ?? projectDisplayLabel(project.project)))
    .sort((left, right) => left.latestUpdatedAt.localeCompare(right.latestUpdatedAt));
  const latestUpdatedAt = sessions.reduce((latest, session) => (
    session.latestUpdatedAt > latest ? session.latestUpdatedAt : latest
  ), sessions[0]!.latestUpdatedAt);
  return {
    projectKey: PROJECT_DREAMING_PROJECT_KEY,
    label: PROJECT_DREAMING_PROJECT_KEY,
    latestUpdatedAt,
    sessions,
  };
}

function createProjectDreamingSession(project: ProjectDreamProjectView, label: string): ProjectSessionNode {
  return {
    sessionKey: PROJECT_DREAMING_SESSION_KEY,
    displaySessionId: label,
    projectKey: project.project,
    latestUpdatedAt: project.latestUpdatedAt,
    kind: 'dreaming',
    agent: PROJECT_DREAMING_AGENT,
    turns: [],
    segments: [],
    timeline: [],
    nextOffset: null,
    loading: false,
    loaded: true,
  };
}

export function isProjectDreamingProject(project: Pick<ProjectNode, 'projectKey'>): boolean {
  return project.projectKey === PROJECT_DREAMING_PROJECT_KEY;
}

export function isProjectDreamingSession(session: Pick<ProjectSessionNode, 'kind' | 'sessionKey' | 'agent'>): boolean {
  return session.kind === 'dreaming'
    || (session.sessionKey === PROJECT_DREAMING_SESSION_KEY && session.agent === PROJECT_DREAMING_AGENT);
}

function emptyProjectDream(project: string): ProjectDreamView {
  return {
    project,
    memorySignals: [],
    skills: [],
  };
}

function projectKeyFromSession(session: SessionNode): string {
  return session.projectKey;
}

async function safeJson<T>(response: Response): Promise<T | null> {
  try {
    return await response.json() as T;
  } catch {
    return null;
  }
}
