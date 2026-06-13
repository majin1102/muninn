import * as SessionIdentity from '@muninn/types/session-identity';
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

export function sessionOptionsForProjects(
  projects: ProjectNode[],
  projectKeys: string[],
): SearchSessionOption[] {
  const selected = new Set(projectKeys);
  return projects
    .filter((project) => selected.size === 0 || selected.has(project.projectKey))
    .flatMap((project) => project.sessions.map((session) => ({
      label: session.displaySessionId,
      value: SessionIdentity.sessionIdentityKey({
        project: project.projectKey,
        agent: session.agent,
        sessionId: session.sessionKey,
      }),
      agent: session.agent,
      description: `${project.label} / ${session.agent}`,
      projectKey: project.projectKey,
      projectLabel: project.label,
      sessionKey: session.sessionKey,
    })));
}

export function sessionKeysForRequest(values: string[], options: SearchSessionOption[]): string[] {
  const optionByValue = new Map(options.map((option) => [option.value, option]));
  return [...new Set(values.map((value) => optionByValue.get(value)?.value ?? value))];
}

export function normalizeSearchN(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
