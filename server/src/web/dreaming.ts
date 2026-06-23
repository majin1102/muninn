import { Hono } from 'hono';
import type {
  ProjectDreamProjectView,
  ProjectDreamProjectsResponse,
  ProjectDreamView,
  ProjectDreamViewResponse,
} from '@muninn/common';
import type { ProjectDreamSignals } from '../dreaming/content.js';
import { dreaming, turns } from '../backend.js';
import { errorResponse, generateRequestId } from './request.js';

export const dreamingRoutes = new Hono();

dreamingRoutes.get('/app/api/dreaming/projects', async (c) => {
  const database = c.req.query('database');
  try {
    const projects = await dreaming.listProjects(database);
    const response: ProjectDreamProjectsResponse = {
      projects: buildProjectDreamProjectsView(projects),
      requestId: generateRequestId(),
    };
    return c.json(response);
  } catch (error) {
    return c.json(errorResponse('internalError', error instanceof Error ? error.message : 'failed to load project dreams'), 500);
  }
});

dreamingRoutes.get('/app/api/dreaming/project', async (c) => {
  const project = c.req.query('project')?.trim();
  const database = c.req.query('database');
  if (!project) {
    return c.json(errorResponse('invalidRequest', 'project is required'), 400);
  }

  try {
    const signals = await dreaming.getProjectSignals(project, database, 20);
    const supportTurnContent = await loadSupportTurnContent(signals, database);
    const response: ProjectDreamViewResponse = {
      dream: buildProjectDreamView(project, signals, supportTurnContent),
      requestId: generateRequestId(),
    };
    return c.json(response);
  } catch (error) {
    return c.json(errorResponse('internalError', error instanceof Error ? error.message : 'failed to load project dream'), 500);
  }
});

export function buildProjectDreamProjectsView(projects: ProjectDreamProjectView[]): ProjectDreamProjectView[] {
  return projects
    .map((project) => ({ ...project }))
    .sort((left, right) => left.project.localeCompare(right.project));
}

export function buildProjectDreamView(
  project: string,
  signals: ProjectDreamSignals | null | undefined,
  supportTurnContent: ReadonlyMap<string, string> = new Map(),
): ProjectDreamView {
  if (!signals) {
    return emptyProjectDreamView(project);
  }
  return {
    project,
    memorySignals: signals.memorySignals.map((signal) => ({
      ...signal,
      supportTurns: signal.supportTurns.map((support) => ({
        ...support,
        content: supportTurnContent.get(support.turnId) ?? 'Turn content unavailable',
      })),
    })),
    skills: signals.skillSignals,
  };
}

async function loadSupportTurnContent(
  signals: ProjectDreamSignals | null | undefined,
  database?: string | null,
): Promise<Map<string, string>> {
  const turnIds = [...new Set(
    signals?.memorySignals.flatMap((signal) => signal.supportTurns.map((support) => support.turnId)) ?? [],
  )];
  const result = new Map<string, string>();
  await Promise.all(turnIds.map(async (turnId) => {
    const turn = await turns.get(turnId, database).catch(() => null);
    result.set(turnId, previewTurnContent(turn));
  }));
  return result;
}

function previewTurnContent(turn: Awaited<ReturnType<typeof turns.get>>): string {
  return turn?.prompt?.trim()
    || turn?.response?.trim()
    || 'Turn content unavailable';
}

function emptyProjectDreamView(project: string): ProjectDreamView {
  return {
    project,
    memorySignals: [],
    skills: [],
  };
}
