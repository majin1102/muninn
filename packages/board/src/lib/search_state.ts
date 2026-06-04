import type { ProjectNode } from './api.js';

export type SearchControlsState = {
  query: string;
  projectKeys: string[];
  sessionKeys: string[];
  sessionTopN: number;
  topN: number;
};

export type SearchSessionOption = {
  label: string;
  value: string;
  agent: string;
  description: string;
  projectKey: string;
  projectLabel: string;
  sessionKey: string;
};

export const SEARCH_ALL_VALUE = 'all';
export const DEFAULT_SESSION_TOP_N = 3;
export const DEFAULT_TOP_N = 20;

export function defaultSearchControls(): SearchControlsState {
  return {
    query: '',
    projectKeys: [],
    sessionKeys: [],
    sessionTopN: DEFAULT_SESSION_TOP_N,
    topN: DEFAULT_TOP_N,
  };
}

export function buildSearchParams(state: SearchControlsState): URLSearchParams {
  const params = new URLSearchParams({
    query: state.query.trim(),
    sessionTopN: String(state.sessionTopN),
    topN: String(state.topN),
  });

  for (const projectKey of state.projectKeys) {
    params.append('projectKey', projectKey);
  }
  for (const sessionKey of state.sessionKeys) {
    params.append('sessionKey', sessionKey);
  }

  return params;
}

export function sessionOptionsForProjects(
  projects: ProjectNode[],
  projectKeys: string[],
): SearchSessionOption[] {
  const selected = new Set(projectKeys);
  return projects
    .filter((project) => selected.size === 0 || selected.has(project.projectKey))
    .flatMap((project) => project.sessions.map((session) => ({
      label: session.displaySessionId,
      value: sessionOptionValue(project.projectKey, session.agent, session.sessionKey),
      agent: session.agent,
      description: `${project.label} / ${session.agent}`,
      projectKey: project.projectKey,
      projectLabel: project.label,
      sessionKey: session.sessionKey,
    })));
}

export function sessionOptionsForProject(
  projects: ProjectNode[],
  projectKey: string,
): SearchSessionOption[] {
  return sessionOptionsForProjects(projects, projectKey === SEARCH_ALL_VALUE ? [] : [projectKey]);
}

export function normalizeSearchN(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sessionOptionValue(projectKey: string, agent: string, sessionKey: string): string {
  return `${projectKey}\u001f${agent}\u001f${sessionKey}`;
}
