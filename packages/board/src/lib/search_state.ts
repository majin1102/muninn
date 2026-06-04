import type { ProjectNode } from './api.js';

export type SearchControlsState = {
  query: string;
  projectKey: string;
  sessionKey: string;
  sessionTopN: number;
  topN: number;
};

export const SEARCH_ALL_VALUE = 'all';
export const DEFAULT_SESSION_TOP_N = 3;
export const DEFAULT_TOP_N = 20;

export function defaultSearchControls(): SearchControlsState {
  return {
    query: '',
    projectKey: SEARCH_ALL_VALUE,
    sessionKey: SEARCH_ALL_VALUE,
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

  if (state.projectKey !== SEARCH_ALL_VALUE) {
    params.set('projectKey', state.projectKey);
    if (state.sessionKey !== SEARCH_ALL_VALUE) {
      params.set('sessionKey', state.sessionKey);
    }
  }

  return params;
}

export function sessionOptionsForProject(
  projects: ProjectNode[],
  projectKey: string,
): Array<{ label: string; value: string }> {
  if (projectKey === SEARCH_ALL_VALUE) {
    return [];
  }
  const project = projects.find((item) => item.projectKey === projectKey);
  if (!project) {
    return [];
  }
  return project.sessions.map((session) => ({
    label: session.displaySessionId,
    value: session.sessionKey,
  }));
}

export function normalizeSearchN(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
