import type { PipelineTasksResponse } from '@muninn/types';
import {
  demoAgents,
  demoDocuments,
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
import type { AgentRecallStreamEvent, RecallProvidersResponse, SearchSessionResult } from '@muninn/types';

const SESSION_SCOPE_SEPARATOR = '\u001f';

export async function getDemoSessionAgents(): Promise<DemoSessionAgentItem[]> {
  return demoAgents;
}

export async function getDemoSessionGroups(agent: string): Promise<DemoSessionGroupItem[]> {
  return demoSessionGroups[agent] ?? [];
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
    const [projectKey, _agent, rawSessionKey] = sessionKey.split(SESSION_SCOPE_SEPARATOR);
    return projectKey === result.projectKey && rawSessionKey === result.sessionKey;
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
