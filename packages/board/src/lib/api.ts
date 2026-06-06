import type {
  AgentNode,
  CodexImportPreviewResponse,
  CodexImportRunResponse,
  ErrorResponse,
  MemoryDocument,
  MemoryDocumentResponse,
  PipelineTasksResponse,
  SessionAgentsResponse,
  SessionGroupsResponse,
  SessionNode,
  ExtractionPreview,
  SessionSegmentPreview,
  SessionTurnsResponse,
  SettingsConfigResponse,
  TurnPreview,
} from '@muninn/types';
import {
  getDemoDocument,
  getDemoPipelineTasks,
  getDemoSessionAgents,
  getDemoSessionGroups,
  getDemoSessionTurns,
} from '../demo/provider.js';
import { trimTrailingSlash } from './utils.js';

export type PrimaryView = 'search' | 'wiki' | 'session' | 'pipelines' | 'settings';

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

export type ProjectObservationNode = ExtractionPreview & {
  agent: string;
  sessionKey: string;
  sessionLabel: string;
};

export type ProjectSessionNode = SessionNode & {
  agent: string;
  turns: ProjectTurnNode[];
  segments: ProjectSegmentNode[];
  observations: ProjectObservationNode[];
  sessionSummary?: string;
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

export type BoardClient = {
  apiBase: string;
  usesDemoData: boolean;
  getVersion(): Promise<string>;
  getProjects(): Promise<ProjectNode[]>;
  loadSessionTurns(session: ProjectSessionNode, offset?: number): Promise<{
    turns: ProjectTurnNode[];
    segments: ProjectSegmentNode[];
    observations: ProjectObservationNode[];
    sessionSummary?: string;
    nextOffset: number | null;
  }>;
  getDocument(memoryId: string): Promise<MemoryDocument>;
  getSettingsConfig(): Promise<SettingsConfigResponse>;
  getPipelineTasks(): Promise<PipelineTasksResponse>;
  saveSettingsConfig(content: string): Promise<SettingsConfigResponse>;
  previewCodexImport(projectLimit?: number, projectKeys?: string[]): Promise<CodexImportPreviewResponse>;
  importCodexSessions(projectLimit?: number, projectKeys?: string[]): Promise<CodexImportRunResponse>;
};

type VersionResponse = {
  version: string;
};

export const DEFAULT_BACKEND_VERSION = '0.1.0';

export function resolveApiBase(): string {
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

  if (window.location.pathname.startsWith('/board') || window.location.port === '8080') {
    return trimTrailingSlash(window.location.origin);
  }

  return 'http://localhost:8080';
}

export function resolveUsesDemoData(): boolean {
  localStorage.removeItem('muninn.board.dataMode');
  return /(?:[?&#])demo=1(?:[&#]|$)/.test(window.location.href);
}

export function createBoardClient(apiBase: string, usesDemoData: boolean): BoardClient {
  async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${apiBase}${path}`, init);
    if (!response.ok) {
      const body = await safeJson<ErrorResponse>(response);
      throw new Error(body?.errorMessage ?? `${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
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
        : (await fetchJson<SessionAgentsResponse>('/api/v1/ui/session/agents')).agents;
      const projects = await projectTreeFromAgents(agents, async (agent) => {
        return usesDemoData
          ? await getDemoSessionGroups(agent)
          : (await fetchJson<SessionGroupsResponse>(
            `/api/v1/ui/session/agents/${encodeURIComponent(agent)}/sessions`,
          )).sessions;
      });
      if (!usesDemoData) {
        return projects;
      }

      return Promise.all(projects.map(async (project) => ({
        ...project,
        sessions: await Promise.all(project.sessions.map(async (session) => {
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
            observations: (response.observations ?? []).map((observation) => ({
              ...observation,
              agent: session.agent,
              sessionKey: session.sessionKey,
              sessionLabel: session.displaySessionId,
            })),
            sessionSummary: response.sessionSummary,
            nextOffset: response.nextOffset,
            loaded: true,
          };
        })),
      })));
    },
    async loadSessionTurns(session, offset = 0) {
      const params = new URLSearchParams({
        offset: String(offset),
        limit: '100',
      });
      if (session.cwd) {
        params.set('cwd', session.cwd);
      }
      const response = usesDemoData
        ? await getDemoSessionTurns(session.agent, session.sessionKey, offset, 100)
        : await fetchJson<SessionTurnsResponse>(
          `/api/v1/ui/session/agents/${encodeURIComponent(session.agent)}/sessions/${encodeURIComponent(session.sessionKey)}/turns?${params.toString()}`,
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
        observations: (response.observations ?? []).map((observation) => ({
          ...observation,
          agent: session.agent,
          sessionKey: session.sessionKey,
          sessionLabel: session.displaySessionId,
        })),
        sessionSummary: response.sessionSummary,
        nextOffset: response.nextOffset,
      };
    },
    async getDocument(memoryId) {
      if (usesDemoData) {
        return getDemoDocument(memoryId);
      }
      const response = await fetchJson<MemoryDocumentResponse>(
        `/api/v1/ui/memories/${encodeURIComponent(memoryId)}/document`,
      );
      return response.document;
    },
    getSettingsConfig() {
      return fetchJson<SettingsConfigResponse>('/api/v1/ui/settings/config');
    },
    getPipelineTasks() {
      return usesDemoData
        ? getDemoPipelineTasks()
        : fetchJson<PipelineTasksResponse>('/api/v1/ui/pipelines');
    },
    saveSettingsConfig(content) {
      return fetchJson<SettingsConfigResponse>('/api/v1/ui/settings/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      });
    },
    previewCodexImport(projectLimit = 5, projectKeys = ['muninn', 'lance']) {
      const params = new URLSearchParams({ projectLimit: String(projectLimit) });
      for (const projectKey of projectKeys) {
        params.append('projectKey', projectKey);
      }
      return fetchJson<CodexImportPreviewResponse>(`/api/v1/ui/import/codex/preview?${params.toString()}`);
    },
    importCodexSessions(projectLimit = 5, projectKeys = ['muninn', 'lance']) {
      return fetchJson<CodexImportRunResponse>('/api/v1/ui/import/codex', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectLimit, projectKeys }),
      });
    },
  };
}

async function projectTreeFromAgents(
  agents: AgentNode[],
  getSessions: (agent: string) => Promise<SessionNode[]>,
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
        agent: agent.agent,
        turns: [],
        segments: [],
        observations: [],
        nextOffset: null,
        loading: false,
        loaded: false,
      });
      projects.set(projectKey, project);
    }
  }

  return [...projects.values()]
    .map((project) => ({
      ...project,
      sessions: project.sessions.sort((left, right) => left.latestUpdatedAt.localeCompare(right.latestUpdatedAt)),
    }))
    .sort((left, right) => left.latestUpdatedAt.localeCompare(right.latestUpdatedAt));
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
