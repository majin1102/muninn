import type { PipelineTasksResponse } from '@muninn/types';
import {
  demoAgents,
  demoDocuments,
  demoPipelineTasks,
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
  segments: Array<{ memoryId: string; title: string; createdAt: string }>;
  nextOffset: number | null;
}> {
  const turns = demoSessionTurns[`${agent}::${sessionKey}`] ?? [];
  const page = turns.slice(offset, offset + limit).map(enrichDemoTurn);
  return {
    turns: page,
    segments: turns.map((turn) => ({
      memoryId: turn.memoryId,
      title: turn.title ?? turn.summary,
      createdAt: turn.createdAt,
    })),
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
