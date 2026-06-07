import {
  generateTextStreamWithConfig,
  getNamedLlmConfig,
  getTurnLlmConfig,
  getTurnLlmProviderName,
  listLlmProviderNames,
  type TextProviderConfig,
} from '@muninn/core';
import type {
  AgentRecallStreamEvent,
  RecallProviderOption,
  SearchSessionResult,
} from '@muninn/types';

export type AgentRecallParams = {
  query: string;
  provider: string;
  results: SearchSessionResult[];
  signal?: AbortSignal;
};

const SYSTEM_PROMPT = [
  'You answer user questions using only the provided Muninn search results.',
  'If the search results do not contain enough context, say that clearly.',
  'Do not invent facts outside the provided context.',
  'Keep the answer concise and directly useful.',
].join('\n');

export function recallProviderOptions(): RecallProviderOption[] {
  const names = listLlmProviderNames();
  return [
    { label: 'None', value: 'none' },
    { label: 'Default', value: 'default' },
    ...names.map((name) => ({ label: name, value: name })),
  ];
}

export async function* agentRecall(params: AgentRecallParams): AsyncIterable<string> {
  const query = params.query.trim();
  if (!query) {
    return;
  }
  if (params.results.length === 0) {
    return;
  }
  const config = providerConfig(params.provider);
  if (!config) {
    throw new Error(`provider is not configured: ${params.provider}`);
  }
  yield* generateTextStreamWithConfig(config, {
    system: SYSTEM_PROMPT,
    prompt: agentPrompt(query, params.results),
    signal: params.signal,
  });
}

export function ndjsonStream(events: AsyncIterable<AgentRecallStreamEvent>): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      try {
        for await (const event of events) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
      } finally {
        controller.close();
      }
    },
  }), {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache',
    },
  });
}

export async function* agentRecallEvents(params: AgentRecallParams): AsyncIterable<AgentRecallStreamEvent> {
  try {
    for await (const text of agentRecall(params)) {
      if (text) {
        yield { type: 'delta', text };
      }
    }
    yield { type: 'done' };
  } catch (error) {
    yield {
      type: 'error',
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

function providerConfig(provider: string): TextProviderConfig | null {
  if (provider === 'none') {
    return null;
  }
  if (provider === 'default') {
    return getTurnLlmConfig();
  }
  return getNamedLlmConfig(provider);
}

function agentPrompt(query: string, results: SearchSessionResult[]): string {
  return [
    'User question:',
    query,
    '',
    'Search results:',
    ...results.flatMap((result, resultIndex) => (
      result.items.map((item, itemIndex) => [
        '',
        `[${resultIndex + 1}.${itemIndex + 1}]`,
        `Session: ${result.sessionLabel}`,
        `Project: ${result.projectKey}`,
        `Source: ${item.source}`,
        item.title ? `Title: ${item.title}` : undefined,
        `Content: ${item.content}`,
      ].filter(Boolean).join('\n'))
    )),
    '',
    'Final response:',
  ].join('\n');
}

export const __testing = {
  agentPrompt,
  providerConfig,
  recallProviderOptions,
  defaultProviderName: getTurnLlmProviderName,
};
