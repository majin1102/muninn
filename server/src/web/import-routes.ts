import { Hono } from 'hono';
import type {
  CodexImportPreviewResponse,
  CodexImportRunResponse,
  ImportedProjectsResponse,
  ImportLocalProjectsResponse,
  ImportSelectedResponse,
  ImportSessionsListResponse,
} from '@muninn/common';
import { isCanonicalProjectIdentity } from '../config.js';
import {
  getCapturePolicy,
  isAgentCaptureEnabled,
  setAgentCaptureEnabled,
  setCaptureEnabled,
} from '../api/capture.js';
import {
  claudeAdapter,
  codexAdapter,
  deleteImportedProject,
  deleteImportedSession,
  importProjects,
  importSelectedSessions,
  listImportedSessions,
  listLocalProjects,
  listLocalSessions,
  previewCodexImport,
  runCodexImport,
  type ImportAdapter,
} from './import.js';
import { invalidateSessionTreeCache } from './sessions.js';
import { errorResponse, generateRequestId } from './request.js';

export const importRoutes = new Hono();

const importAdapters: Record<string, ImportAdapter> = {
  codex: codexAdapter,
  'claude-code': claudeAdapter,
};

function normalizeText(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

importRoutes.get('/app/api/import/codex/preview', async (c) => {
  const projectLimit = parseOptionalInteger(c.req.query('projectLimit'));
  const sourceRoot = c.req.query('sourceRoot');
  const projectKeys = c.req.queries('projectKey');
  const response: CodexImportPreviewResponse = await previewCodexImport({
    sourceRoot,
    projectLimit,
    projectKeys,
  }, generateRequestId());
  return c.json(response);
});

importRoutes.post('/app/api/import/codex', async (c) => {
  let body: { sourceRoot?: string; projectLimit?: number; projectKeys?: string[] } = {};
  try {
    body = await c.req.json<{ sourceRoot?: string; projectLimit?: number; projectKeys?: string[] }>();
  } catch {
    body = {};
  }

  invalidateSessionTreeCache();
  const response: CodexImportRunResponse = await runCodexImport({
    sourceRoot: body.sourceRoot,
    projectLimit: body.projectLimit,
    projectKeys: body.projectKeys,
  }, generateRequestId());
  invalidateSessionTreeCache();
  return c.json(response);
});

importRoutes.get('/app/api/import/projects', async (c) => {
  const requestId = generateRequestId();
  const importedByAgent = await Promise.all(Object.values(importAdapters).map(async (adapter) => ({
    adapter,
    response: await listImportedSessions(adapter, requestId),
  })));
  const grouped = new Map<string, ImportedProjectsResponse['projects'][number]>();

  for (const { adapter, response } of importedByAgent) {
    for (const project of response.projects) {
      const latestUpdatedAt = project.sessions[0]?.updatedAt ?? '';
      const group = grouped.get(project.project) ?? {
        project: project.project,
        sessionCount: 0,
        importedCount: 0,
        latestUpdatedAt,
        agents: [],
        sessions: [],
      };
      group.sessionCount += project.sessionCount;
      group.importedCount += project.importedCount;
      if (latestUpdatedAt > group.latestUpdatedAt) {
        group.latestUpdatedAt = latestUpdatedAt;
      }
      group.agents.push({
        agent: adapter.agent,
        sessionCount: project.sessionCount,
        importedCount: project.importedCount,
        captureEnabled: project.captureEnabled,
      });
      group.sessions.push(...project.sessions.map((session) => ({ agent: adapter.agent, session })));
      grouped.set(project.project, group);
    }
  }

  for (const { adapter } of importedByAgent) {
    const policy = await getCapturePolicy(adapter.agent);
    for (const [project, enabled] of Object.entries(policy)) {
      if (!enabled || !isCanonicalProjectIdentity(project)) {
        continue;
      }
      const group = grouped.get(project) ?? {
        project,
        sessionCount: 0,
        importedCount: 0,
        latestUpdatedAt: '',
        agents: [],
        sessions: [],
      };
      if (!group.agents.some((agent) => agent.agent === adapter.agent)) {
        group.agents.push({
          agent: adapter.agent,
          sessionCount: 0,
          importedCount: 0,
          captureEnabled: true,
        });
      }
      grouped.set(project, group);
    }
  }

  const projects = [...grouped.values()]
    .map((project) => ({
      ...project,
      agents: project.agents.sort((left, right) => left.agent.localeCompare(right.agent)),
      sessions: project.sessions.sort((left, right) => right.session.updatedAt.localeCompare(left.session.updatedAt)),
    }))
    .sort((left, right) => right.latestUpdatedAt.localeCompare(left.latestUpdatedAt));

  const response: ImportedProjectsResponse = {
    agents: await Promise.all(importedByAgent.map(async ({ adapter }) => ({
      agent: adapter.agent,
      sourceRoot: adapter.sourceRoot,
      captureEnabled: await isAgentCaptureEnabled(adapter.agent),
    }))),
    projectCount: projects.length,
    sessionCount: projects.reduce((total, project) => total + project.sessionCount, 0),
    importedCount: projects.reduce((total, project) => total + project.importedCount, 0),
    projects,
    requestId,
  };

  return c.json(response);
});

importRoutes.get('/app/api/import/:agent/sessions', async (c) => {
  const adapter = importAdapters[c.req.param('agent')];
  if (!adapter) {
    return c.json(errorResponse('invalidRequest', 'unknown import agent'), 404);
  }
  const project = normalizeText(c.req.query('project'));
  const response: ImportSessionsListResponse = c.req.query('scope') === 'imported'
    ? await listImportedSessions(adapter, generateRequestId())
    : await listLocalSessions(adapter, generateRequestId(), project);
  return c.json(response);
});

importRoutes.get('/app/api/import/:agent/local-projects', async (c) => {
  const adapter = importAdapters[c.req.param('agent')];
  if (!adapter) {
    return c.json(errorResponse('invalidRequest', 'unknown import agent'), 404);
  }
  const response: ImportLocalProjectsResponse = await listLocalProjects(adapter, generateRequestId());
  return c.json(response);
});

importRoutes.put('/app/api/import/:agent/capture-policy', async (c) => {
  const agent = c.req.param('agent');
  if (!importAdapters[agent]) {
    return c.json(errorResponse('invalidRequest', 'unknown import agent'), 404);
  }
  let body: { project?: string; enabled?: boolean } = {};
  try {
    body = await c.req.json<{ project?: string; enabled?: boolean }>();
  } catch {
    body = {};
  }
  if (typeof body.project !== 'string' || !body.project || typeof body.enabled !== 'boolean') {
    return c.json(errorResponse('invalidRequest', 'project and enabled are required'), 400);
  }
  if (!isCanonicalProjectIdentity(body.project)) {
    return c.json(errorResponse('invalidRequest', 'project must be a canonical project identity'), 400);
  }
  await setCaptureEnabled(agent, body.project, body.enabled);
  return c.body(null, 204);
});

importRoutes.put('/app/api/import/:agent/agent-capture', async (c) => {
  const agent = c.req.param('agent');
  if (!importAdapters[agent]) {
    return c.json(errorResponse('invalidRequest', 'unknown import agent'), 404);
  }
  let body: { enabled?: boolean } = {};
  try {
    body = await c.req.json<{ enabled?: boolean }>();
  } catch {
    body = {};
  }
  if (typeof body.enabled !== 'boolean') {
    return c.json(errorResponse('invalidRequest', 'enabled is required'), 400);
  }
  await setAgentCaptureEnabled(agent, body.enabled);
  return c.body(null, 204);
});

importRoutes.post('/app/api/import/:agent/projects', async (c) => {
  const adapter = importAdapters[c.req.param('agent')];
  if (!adapter) {
    return c.json(errorResponse('invalidRequest', 'unknown import agent'), 404);
  }
  let body: { projects?: string[] } = {};
  try {
    body = await c.req.json<{ projects?: string[] }>();
  } catch {
    body = {};
  }
  const projects = Array.isArray(body.projects) ? body.projects.filter((project): project is string => typeof project === 'string' && project.length > 0) : [];
  if (projects.length === 0) {
    return c.json(errorResponse('invalidRequest', 'projects is required'), 400);
  }
  if (projects.some((project) => !isCanonicalProjectIdentity(project))) {
    return c.json(errorResponse('invalidRequest', 'projects must be canonical project identities'), 400);
  }
  const response = await importProjects(adapter, projects, generateRequestId());
  return c.json(response);
});

importRoutes.delete('/app/api/import/:agent/session', async (c) => {
  const adapter = importAdapters[c.req.param('agent')];
  if (!adapter) {
    return c.json(errorResponse('invalidRequest', 'unknown import agent'), 404);
  }
  let body: { project?: string; sessionId?: string } = {};
  try {
    body = await c.req.json<{ project?: string; sessionId?: string }>();
  } catch {
    body = {};
  }
  if (typeof body.project !== 'string' || !body.project || typeof body.sessionId !== 'string' || !body.sessionId) {
    return c.json(errorResponse('invalidRequest', 'project and sessionId are required'), 400);
  }
  invalidateSessionTreeCache();
  const response = await deleteImportedSession(adapter, body.project, body.sessionId, generateRequestId());
  invalidateSessionTreeCache();
  return c.json(response);
});

importRoutes.delete('/app/api/import/:agent/project', async (c) => {
  const adapter = importAdapters[c.req.param('agent')];
  if (!adapter) {
    return c.json(errorResponse('invalidRequest', 'unknown import agent'), 404);
  }
  let body: { project?: string } = {};
  try {
    body = await c.req.json<{ project?: string }>();
  } catch {
    body = {};
  }
  if (typeof body.project !== 'string' || !body.project) {
    return c.json(errorResponse('invalidRequest', 'project is required'), 400);
  }
  invalidateSessionTreeCache();
  const response = await deleteImportedProject(adapter, body.project, generateRequestId());
  invalidateSessionTreeCache();
  return c.json(response);
});

importRoutes.post('/app/api/import/:agent/sessions', async (c) => {
  const adapter = importAdapters[c.req.param('agent')];
  if (!adapter) {
    return c.json(errorResponse('invalidRequest', 'unknown import agent'), 404);
  }
  let body: { sourcePaths?: string[] } = {};
  try {
    body = await c.req.json<{ sourcePaths?: string[] }>();
  } catch {
    body = {};
  }
  const sourcePaths = Array.isArray(body.sourcePaths) ? body.sourcePaths.filter((path): path is string => typeof path === 'string' && path.length > 0) : [];
  if (sourcePaths.length === 0) {
    return c.json(errorResponse('invalidRequest', 'sourcePaths is required'), 400);
  }
  invalidateSessionTreeCache();
  const response: ImportSelectedResponse = await importSelectedSessions(adapter, sourcePaths, generateRequestId());
  invalidateSessionTreeCache();
  return c.json(response);
});

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

