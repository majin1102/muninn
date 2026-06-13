import type { DeleteImportedProjectResponse, ImportedProjectsResponse, ImportProjectsResponse, ImportSelectedResponse, ImportSessionsListResponse, PipelineTasksResponse } from '@muninn/common';
import {
  demoAgents,
  demoDocuments,
  demoImportAgents,
  demoPipelineTasks,
  demoSearchResults,
  demoSessionSnapshots,
  demoSessionGroups,
  demoSessionTurns,
  type DemoMemoryDocument,
  type DemoSessionSnapshotListItem,
  type DemoSessionAgentItem,
  type DemoSessionGroupItem,
  type DemoSessionTimelineItem,
} from './data.js';
import { shiftPipelineTaskTimes, summarizePipelineTasks } from '../lib/pipeline_model.js';
import type { AgentRecallStreamEvent, RecallProvidersResponse, SearchSessionResult } from '@muninn/common';
import { sessionIdentityKeyMatches } from '@muninn/common/session-identity';

const demoImportState = structuredClone(demoImportAgents);
const demoRegisteredProjects: Record<string, Set<string>> = Object.fromEntries(
  Object.keys(demoImportState).map((agent) => [agent, new Set<string>()]),
);
const demoAgentCapture: Record<string, boolean> = Object.fromEntries(
  Object.keys(demoImportState).map((agent) => [agent, true]),
);

export async function getDemoSessionAgents(): Promise<DemoSessionAgentItem[]> {
  return demoAgents;
}

export async function getDemoSessionGroups(agent: string): Promise<DemoSessionGroupItem[]> {
  return demoSessionGroups[agent] ?? [];
}

export async function getDemoImportSessions(agent: string, scope?: 'imported'): Promise<ImportSessionsListResponse> {
  const data = demoImportState[agent] ?? { sourceRoot: demoImportRoot(agent), projects: [] };
  const projects = data.projects
    .map((project) => ({
      ...project,
      sessions: project.sessions.filter((session) => scope !== 'imported' || session.imported),
    }))
    .filter((project) => project.sessions.length > 0)
    .map((project) => ({
      ...project,
      sessionCount: project.sessions.length,
      importedCount: project.sessions.filter((session) => session.imported).length,
    }));
  return {
    sourceRoot: data.sourceRoot,
    projectCount: projects.length,
    sessionCount: projects.reduce((total, project) => total + project.sessionCount, 0),
    importedCount: projects.reduce((total, project) => total + project.importedCount, 0),
    projects,
    requestId: `demo-import-${agent}`,
  };
}

export async function getDemoImportedProjects(): Promise<ImportedProjectsResponse> {
  const grouped = new Map<string, ImportedProjectsResponse['projects'][number]>();

  for (const [agent, data] of Object.entries(demoImportState)) {
    for (const project of data.projects) {
      const importedSessions = project.sessions.filter((session) => session.imported);
      if (importedSessions.length === 0 && !demoRegisteredProjects[agent]?.has(project.project)) {
        continue;
      }
      const latestUpdatedAt = importedSessions[0]?.updatedAt ?? '';
      const group = grouped.get(project.project) ?? {
        project: project.project,
        sessionCount: 0,
        importedCount: 0,
        latestUpdatedAt,
        agents: [],
        sessions: [],
      };
      group.sessionCount += importedSessions.length;
      group.importedCount += importedSessions.length;
      if (latestUpdatedAt > group.latestUpdatedAt) {
        group.latestUpdatedAt = latestUpdatedAt;
      }
      group.agents.push({
        agent,
        sessionCount: importedSessions.length,
        importedCount: importedSessions.length,
        captureEnabled: project.captureEnabled,
      });
      group.sessions.push(...importedSessions.map((session) => ({ agent, session })));
      grouped.set(project.project, group);
    }
  }

  const projects = [...grouped.values()]
    .map((project) => ({
      ...project,
      agents: project.agents.sort((left, right) => left.agent.localeCompare(right.agent)),
      sessions: project.sessions.sort((left, right) => right.session.updatedAt.localeCompare(left.session.updatedAt)),
    }))
    .sort((left, right) => right.latestUpdatedAt.localeCompare(left.latestUpdatedAt));

  return {
    agents: Object.entries(demoImportState).map(([agent, data]) => ({
      agent,
      sourceRoot: data.sourceRoot,
      captureEnabled: demoAgentCapture[agent] !== false,
    })),
    projectCount: projects.length,
    sessionCount: projects.reduce((total, project) => total + project.sessionCount, 0),
    importedCount: projects.reduce((total, project) => total + project.importedCount, 0),
    projects,
    requestId: 'demo-import-projects',
  };
}

export async function importDemoProjects(agent: string, projects: string[]): Promise<ImportProjectsResponse> {
  const data = demoImportState[agent];
  if (!data) {
    return { importedProjects: 0, requestId: `demo-import-projects-${agent}` };
  }
  const registered = demoRegisteredProjects[agent] ?? new Set<string>();
  demoRegisteredProjects[agent] = registered;
  let importedProjects = 0;
  for (const project of new Set(projects)) {
    const item = data.projects.find((candidate) => candidate.project === project);
    if (!item || registered.has(project)) {
      continue;
    }
    registered.add(project);
    item.captureEnabled = true;
    importedProjects += 1;
  }
  return { importedProjects, requestId: `demo-import-projects-${agent}` };
}

export async function importDemoSessionsByPaths(agent: string, sourcePaths: string[]): Promise<ImportSelectedResponse> {
  const data = demoImportState[agent];
  if (!data) {
    return { importedSessions: 0, importedTurns: 0, failedSessions: [], requestId: `demo-import-${agent}` };
  }
  const selected = new Set(sourcePaths);
  let importedSessions = 0;
  let importedTurns = 0;
  for (const project of data.projects) {
    let changedProject = false;
    for (const session of project.sessions) {
      if (!session.sourcePath || !selected.has(session.sourcePath) || session.imported) {
        continue;
      }
      session.imported = true;
      importedSessions += 1;
      importedTurns += session.turnCount ?? 0;
      changedProject = true;
    }
    if (changedProject) {
      project.captureEnabled = true;
      const registered = demoRegisteredProjects[agent] ?? new Set<string>();
      registered.add(project.project);
      demoRegisteredProjects[agent] = registered;
    }
    project.importedCount = project.sessions.filter((session) => session.imported).length;
    project.sessionCount = project.sessions.length;
  }
  return {
    importedSessions,
    importedTurns,
    failedSessions: [],
    requestId: `demo-import-${agent}`,
  };
}

export async function deleteDemoImportedProject(agent: string, project: string): Promise<DeleteImportedProjectResponse> {
  const item = demoImportState[agent]?.projects.find((candidate) => candidate.project === project);
  if (!item) {
    return { deletedSessions: 0, deletedTurns: 0, requestId: `demo-delete-${agent}` };
  }
  const deletedSessions = item.sessions.filter((session) => session.imported).length;
  const deletedTurns = item.sessions.reduce((total, session) => (
    total + (session.imported ? session.turnCount ?? 0 : 0)
  ), 0);
  for (const session of item.sessions) {
    session.imported = false;
  }
  item.importedCount = 0;
  item.captureEnabled = false;
  demoRegisteredProjects[agent]?.delete(project);
  return {
    deletedSessions,
    deletedTurns,
    requestId: `demo-delete-${agent}`,
  };
}

export async function setDemoCapturePolicy(agent: string, project: string, enabled: boolean): Promise<void> {
  const item = demoImportState[agent]?.projects.find((candidate) => candidate.project === project);
  if (item) {
    item.captureEnabled = enabled;
    const registered = demoRegisteredProjects[agent] ?? new Set<string>();
    registered.add(project);
    demoRegisteredProjects[agent] = registered;
  }
}

export async function setDemoAgentCapturePolicy(agent: string, enabled: boolean): Promise<void> {
  demoAgentCapture[agent] = enabled;
}

function demoImportRoot(agent: string): string {
  return agent === 'claude-code' ? '/Users/Nathan/.claude/projects' : '/Users/Nathan/.codex';
}

export async function getDemoSessionTurns(
  agent: string,
  sessionKey: string,
  offset: number,
  limit: number,
): Promise<{
  turns: DemoSessionTimelineItem[];
  segments: Array<{ memoryId: string; title: string; createdAt: string; updatedAt: string }>;
  observations: Array<{ memoryId: string; title: string; createdAt: string; updatedAt: string; markdown: string; refs: string[] }>;
  sessionSummary?: string;
  nextOffset: number | null;
}> {
  const turns = demoSessionTurns[`${agent}::${sessionKey}`] ?? [];
  const page = turns.slice(offset, offset + limit).map(enrichDemoTurn);
  const observations = turns.map((turn) => ({
    memoryId: turn.memoryId,
    title: turn.title ?? turn.summary,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    markdown: [
      '### Summary',
      turn.summary,
      '',
      '### Content',
      turn.prompt ? `- Prompt: ${turn.prompt}` : undefined,
      turn.response ? `- Response: ${turn.response}` : undefined,
    ].filter(Boolean).join('\n'),
    refs: [turn.memoryId],
  }));
  return {
    turns: page,
    segments: turns.map((turn) => ({
      memoryId: turn.memoryId,
      title: turn.title ?? turn.summary,
      createdAt: turn.createdAt,
      updatedAt: turn.updatedAt,
    })),
    observations,
    sessionSummary: turns[0]?.summary,
    nextOffset: offset + limit < turns.length ? offset + limit : null,
  };
}

function enrichDemoTurn(turn: DemoSessionTimelineItem): DemoSessionTimelineItem {
  const document = demoDocuments[turn.memoryId];
  if (!document) {
    return turn;
  }
  return {
    ...turn,
    prompt: sectionText(document.markdown, 'Prompt') ?? turn.prompt,
    response: sectionText(document.markdown, 'Response') ?? turn.response ?? turn.summary,
    toolCalls: toolCallsFromMarkdown(document.markdown) ?? turn.toolCalls,
  };
}

function sectionText(markdown: string, heading: string): string | undefined {
  const pattern = new RegExp(`^## ${escapeRegExp(heading)}\\n+([\\s\\S]*?)(?=\\n## |$)`, 'm');
  const match = markdown.match(pattern);
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

function toolCallsFromMarkdown(markdown: string): DemoSessionTimelineItem['toolCalls'] {
  const toolCalling = sectionText(markdown, 'Tool Calling');
  const toolArtifacts = sectionText(markdown, 'Tool Artifacts');
  const toolCalls = [
    ...toolListItems(toolCalling).map((name, index) => ({
      id: `demo-tool-call-${index + 1}`,
      name,
    })),
    ...toolListItems(toolArtifacts).map((output, index) => ({
      id: `demo-tool-artifact-${index + 1}`,
      name: 'tool_artifact',
      output,
    })),
  ];
  return toolCalls.length > 0 ? toolCalls : undefined;
}

function toolListItems(section: string | undefined): string[] {
  if (!section) {
    return [];
  }
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function getDemoSessionSnapshots(): Promise<DemoSessionSnapshotListItem[]> {
  return demoSessionSnapshots;
}

export async function getDemoPipelineTasks(): Promise<PipelineTasksResponse> {
  const tasks = shiftPipelineTaskTimes(demoPipelineTasks);
  return {
    summary: summarizePipelineTasks(tasks),
    tasks,
    requestId: 'demo-pipelines',
  };
}

export async function getDemoDocument(memoryId: string): Promise<DemoMemoryDocument> {
  const document = demoDocuments[memoryId];
  if (!document) {
    throw new Error(`demo memory not found: ${memoryId}`);
  }
  return document;
}

export async function getDemoSearchResults(params: {
  query: string;
  projectKeys?: string[];
  sessionKeys?: string[];
  sessionTopN: number;
  topN: number;
}): Promise<SearchSessionResult[]> {
  const query = params.query.trim().toLowerCase();
  const projectKeys = new Set(params.projectKeys ?? []);
  const sessionKeys = new Set(params.sessionKeys ?? []);
  const results: SearchSessionResult[] = [];
  let total = 0;
  for (const result of demoSearchResults
    .filter((result) => projectKeys.size === 0 || projectKeys.has(result.projectKey))
    .filter((result) => matchesDemoSessionScope(result, sessionKeys))) {
    if (total >= params.topN) {
      break;
    }
    const items = result.items.filter((item) => (
      !query
      || result.sessionLabel.toLowerCase().includes(query)
      || item.title?.toLowerCase().includes(query)
      || item.content.toLowerCase().includes(query)
    )).slice(0, Math.min(params.sessionTopN, params.topN - total));
    if (items.length === 0) {
      continue;
    }
    results.push({
      ...result,
      items,
    });
    total += items.length;
  }
  return results;
}

function matchesDemoSessionScope(result: SearchSessionResult, sessionKeys: Set<string>): boolean {
  if (sessionKeys.size === 0 || sessionKeys.has(result.sessionKey)) {
    return true;
  }
  return [...sessionKeys].some((sessionKey) => {
    return sessionIdentityKeyMatches(sessionKey, {
      project: result.projectKey,
      agent: result.agent,
      sessionId: result.sessionKey,
    });
  });
}

export function getDemoRecallProviders(): RecallProvidersResponse {
  return {
    providers: [
      { label: 'None', value: 'none' },
      { label: 'Default', value: 'default' },
      { label: 'OpenAI', value: 'openai' },
      { label: 'Local', value: 'local' },
    ],
    requestId: 'demo-recall-providers',
  };
}

export async function* streamDemoAgentRecall(
  query: string,
  results: SearchSessionResult[],
): AsyncIterable<AgentRecallStreamEvent> {
  const hits = results.flatMap((result) => result.items.map((item) => ({ result, item })));
  if (hits.length === 0) {
    yield { type: 'done' };
    return;
  }
  const topHits = hits.slice(0, 4);
  const text = [
    `Based on the context I found for "${query}":`,
    '',
    ...topHits.slice(0, 3).map(({ item }) => `- ${previewSentence(item.content)}`),
    '',
    `The right side keeps the source sessions and matched context so you can inspect the evidence directly.`,
  ].join('\n');
  for (const chunk of chunkText(text, 28)) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    yield { type: 'delta', text: chunk };
  }
  yield { type: 'done' };
}

function previewSentence(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  const sentence = normalized.match(/^[^.!?。！？]+[.!?。！？]?/)?.[0]?.trim() ?? normalized;
  return sentence.length > 180 ? `${sentence.slice(0, 177).trim()}...` : sentence;
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}
