import type {
  AgentNode,
  ErrorResponse,
  MemoryDocument,
  MemoryDocumentResponse,
  SessionAgentsResponse,
  SessionGroupsResponse,
  SessionNode,
  SessionTurnsResponse,
  SettingsConfigResponse,
  TurnPreview,
} from '@muninn/types';
import {
  getDemoDocument,
  getDemoSessionAgents,
  getDemoSessionGroups,
  getDemoSessionTurns,
} from '../demo/provider.js';
import { sampleSettingsDraft, settingsDraftToJson } from './settings-model.js';
import { trimTrailingSlash } from './utils.js';

export type PrimaryView = 'search' | 'wiki' | 'session' | 'settings';

export type ProjectTurnNode = TurnPreview & {
  agent: string;
  sessionKey: string;
  sessionLabel: string;
};

export type ProjectSessionNode = SessionNode & {
  agent: string;
  turns: ProjectTurnNode[];
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
    nextOffset: number | null;
  }>;
  getDocument(memoryId: string): Promise<MemoryDocument>;
  getSettingsConfig(): Promise<SettingsConfigResponse>;
  saveSettingsConfig(content: string): Promise<SettingsConfigResponse>;
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
  let demoSettingsContent = settingsDraftToJson(sampleSettingsDraft());

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
            nextOffset: response.nextOffset,
            loaded: true,
          };
        })),
      })));
    },
    async loadSessionTurns(session, offset = 0) {
      const response = usesDemoData
        ? await getDemoSessionTurns(session.agent, session.sessionKey, offset, 10)
        : await fetchJson<SessionTurnsResponse>(
          `/api/v1/ui/session/agents/${encodeURIComponent(session.agent)}/sessions/${encodeURIComponent(session.sessionKey)}/turns?offset=${offset}&limit=10`,
        );
      return {
        turns: response.turns.map((turn) => ({
          ...turn,
          agent: session.agent,
          sessionKey: session.sessionKey,
          sessionLabel: session.displaySessionId,
        })),
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
      if (usesDemoData) {
        return Promise.resolve({
          pathLabel: 'demo muninn.json',
          content: demoSettingsContent,
          requestId: 'demo-settings',
        });
      }
      return fetchJson<SettingsConfigResponse>('/api/v1/ui/settings/config');
    },
    saveSettingsConfig(content) {
      if (usesDemoData) {
        demoSettingsContent = content;
        return Promise.resolve({
          pathLabel: 'demo muninn.json',
          content: demoSettingsContent,
          requestId: 'demo-settings',
        });
      }
      return fetchJson<SettingsConfigResponse>('/api/v1/ui/settings/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
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
      sessions: project.sessions.sort((left, right) => right.latestUpdatedAt.localeCompare(left.latestUpdatedAt)),
    }))
    .sort((left, right) => right.latestUpdatedAt.localeCompare(left.latestUpdatedAt));
}

function projectKeyFromSession(session: SessionNode): string {
  const label = session.displaySessionId || session.sessionKey;
  const [first] = label.split(/[/:#]/).filter(Boolean);
  return first || 'Default Project';
}

async function safeJson<T>(response: Response): Promise<T | null> {
  try {
    return await response.json() as T;
  } catch {
    return null;
  }
}
