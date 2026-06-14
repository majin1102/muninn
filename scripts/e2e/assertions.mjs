import assert from 'node:assert/strict';
import { requestJson, waitFor } from './http.mjs';

export async function importedProjects(baseUrl) {
  return requestJson(baseUrl, '/api/v1/ui/import/projects');
}

export async function importedSessions(baseUrl, agent) {
  return requestJson(baseUrl, `/api/v1/ui/import/${agent}/sessions?scope=imported`);
}

export async function sessionTurns(baseUrl, agent, project, sessionId) {
  const params = new URLSearchParams({
    project,
    offset: '0',
    limit: '20',
  });
  return requestJson(baseUrl, `/api/v1/ui/session/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(sessionId)}/turns?${params.toString()}`);
}

export function projectGroup(projectsResponse, project) {
  return projectsResponse.projects.find((entry) => entry.project === project);
}

export function sessionInProjects(projectsResponse, sessionId) {
  return projectsResponse.projects.flatMap((project) => project.sessions).find((entry) => entry.session.sessionId === sessionId);
}

export async function waitForSession(baseUrl, sessionId, { timeoutMs = 10000 } = {}) {
  return waitFor(async () => {
    const response = await importedProjects(baseUrl);
    return sessionInProjects(response, sessionId);
  }, { timeoutMs, intervalMs: 200, label: `session ${sessionId}` });
}

export async function assertSessionAbsent(baseUrl, sessionId) {
  const response = await importedProjects(baseUrl);
  assert.equal(sessionInProjects(response, sessionId), undefined);
}

export async function assertProjectAbsent(baseUrl, project) {
  const response = await importedProjects(baseUrl);
  assert.equal(projectGroup(response, project), undefined);
}

export async function assertCaptureEnabled(baseUrl, agent, project, expected) {
  const response = await importedProjects(baseUrl);
  const group = projectGroup(response, project);
  const agentRow = group?.agents.find((entry) => entry.agent === agent);
  assert.equal(agentRow?.captureEnabled ?? false, expected);
}

export async function assertSessionTurn(baseUrl, agent, project, sessionId, { prompt, response }) {
  const body = await sessionTurns(baseUrl, agent, project, sessionId);
  const turn = body.turns.find((entry) => entry.prompt === prompt);
  assert.ok(turn, `expected turn prompt ${prompt}`);
  assert.equal(turn.response, response);
  assert.ok(turn.events.some((event) => event.type === 'userMessage'));
  assert.ok(turn.events.some((event) => event.type === 'assistantMessage'));
}
