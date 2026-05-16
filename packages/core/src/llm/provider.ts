import { getExtractorLlmConfig, getObserverLlmConfig, getTurnLlmConfig, type TextProviderConfig } from './config.js';
import { loadCodexCliAuth } from './codex-auth.js';
import { withProviderTimeout } from './timeout.js';

export type LlmTask = 'turn' | 'extractor' | 'observer';

export type LlmTextRequest = {
  system: string;
  prompt: string;
  signal?: AbortSignal;
};

export type LlmTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type LlmToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type LlmToolMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content?: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export type LlmToolRequest = {
  messages: LlmToolMessage[];
  tools: LlmTool[];
  signal?: AbortSignal;
};

export type LlmToolResult =
  | { type: 'final'; text: string }
  | { type: 'tool_calls'; toolCalls: LlmToolCall[] };

export async function generateText(
  task: LlmTask,
  request: LlmTextRequest,
): Promise<string | null> {
  const config = task === 'turn'
    ? getTurnLlmConfig()
    : task === 'extractor'
      ? getExtractorLlmConfig()
      : getObserverLlmConfig();
  if (!config) {
    return null;
  }
  if (config.provider === 'mock') {
    return generateMockText(request);
  }
  if (config.provider === 'openai-codex') {
    return generateOpenAiCodexText(config, request);
  }
  return generateOpenAiText(config, request);
}

export async function generateWithTools(
  task: LlmTask,
  request: LlmToolRequest,
): Promise<LlmToolResult | null> {
  const config = task === 'turn'
    ? getTurnLlmConfig()
    : task === 'extractor'
      ? getExtractorLlmConfig()
      : getObserverLlmConfig();
  if (!config) {
    return null;
  }
  if (config.provider === 'mock') {
    return { type: 'final', text: generateMockText({ system: '', prompt: lastUserMessage(request.messages) }) };
  }
  if (config.provider === 'openai-codex') {
    return generateOpenAiCodexWithTools(config, request);
  }
  return generateOpenAiWithTools(config, request);
}

function generateMockText(request: LlmTextRequest): string {
  const seed = extractBlock(request.prompt, 'User request:', 'Final response:')
    || extractLabeledValue(request.prompt, 'Final response:')
    || request.prompt.trim();

  if (request.system.includes('routing gateway for an observing memory system')) {
    return JSON.stringify({ sessionFragments: [] });
  }
  if (request.system.includes('memory recall agent')) {
    const candidate = extractBlock(request.prompt, '[1]', '\n\n[2]')
      || extractBlock(request.prompt, 'Candidate memories:', 'Task:')
      || request.prompt;
    const content = extractLabeledValue(candidate, 'Content:') || excerpt(candidate);
    const refs = (extractLabeledValue(candidate, 'Refs:') || '')
      .split(',')
      .map((ref) => ref.trim())
      .filter(Boolean);
    return JSON.stringify({
      content: excerpt(content),
      refs,
    });
  }
  if (request.system.includes('observer for an observing memory system')) {
    const ref = request.prompt.match(/extraction:[A-Za-z0-9:_-]+/)?.[0] ?? 'extraction:mock';
    const entity = extractLabeledValue(request.prompt, 'Entity anchor:') || 'Mock entity';
    return [
      `# Entity Memory: ${entity}`,
      '',
      `## Who is ${entity}?`,
      `<refs: [${ref}]>`,
      '',
      `${entity} has curated memory from the provided extraction.`,
    ].join('\n');
  }
  if (request.system.includes('extractor that rewrites one session extraction document')) {
    const ref = request.prompt.match(/(?:session|turn):[A-Za-z0-9:_-]+/)?.[0] ?? 'turn:mock';
    return [
      '# Mock Session Memory',
      '',
      '## Summary',
      'Mock session extraction summary.',
      '',
      '## Extractions',
      `<!-- refs: [${ref}] -->`,
      '[Entity] Mock entity',
      '[Fact] mock extraction',
      '[Extraction] Mock extraction from the provided turn.',
    ].join('\n');
  }
  if (request.system.includes('"memory_delta"')) {
    return JSON.stringify({
      observing_content_update: {
        title: 'Mock observing thread',
        summary: `Mock observing summary: ${excerpt(seed)}`,
        open_questions: [],
        next_steps: [],
      },
      memory_delta: { before: [], after: [] },
    });
  }
  return JSON.stringify({
    title: `Mock title: ${excerpt(seed)}`,
    summary: `Mock summary: ${excerpt(seed)}`,
  });
}

async function generateOpenAiWithTools(
  config: TextProviderConfig,
  request: LlmToolRequest,
): Promise<LlmToolResult> {
  throwIfAborted(request.signal);
  if (!config.apiKey?.trim()) {
    throw new Error('llm.apiKey is required for openai llm provider');
  }

  const apiStyle = normalizeApiStyle(config.api);
  if (apiStyle !== 'chatCompletions') {
    throw new Error('native tool calls require openai-completions/chat_completions api style');
  }

  const baseUrl = config.baseUrl ?? 'https://api.openai.com/v1/chat/completions';
  const timeout = withProviderTimeout(request.signal, 'openai tool request');
  try {
    const response = await fetch(normalizeChatCompletionsUrl(baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      signal: timeout.signal,
      body: JSON.stringify({
        model: config.model ?? 'gpt-5.4-mini',
        messages: request.messages.map(toOpenAiToolMessage),
        tools: request.tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        })),
        tool_choice: 'auto',
      }),
    });

    if (!response.ok) {
      throw new Error(`openai request failed with status ${response.status}: ${await response.text()}`);
    }

    const payload = await response.json() as Record<string, unknown>;
    const choices = Array.isArray(payload.choices) ? payload.choices as Array<{ message?: Record<string, unknown> }> : [];
    const message = choices[0]?.message;
    if (!message) {
      throw new Error('openai-compatible response did not contain a message');
    }
    const toolCalls = parseOpenAiToolCalls(message.tool_calls);
    if (toolCalls.length > 0) {
      return { type: 'tool_calls', toolCalls };
    }
    const content = typeof message.content === 'string' ? message.content.trim() : '';
    if (!content) {
      throw new Error('openai-compatible response did not contain text content or tool calls');
    }
    return { type: 'final', text: content };
  } finally {
    timeout.cleanup();
  }
}

function toOpenAiToolMessage(message: LlmToolMessage): Record<string, unknown> {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content ?? null,
      ...(message.toolCalls?.length
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              },
            })),
          }
        : {}),
    };
  }
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      name: message.name,
      content: message.content,
    };
  }
  return {
    role: message.role,
    content: message.content,
  };
}

function parseOpenAiToolCalls(value: unknown): LlmToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error('openai-compatible tool_calls entries must be objects');
    }
    const record = item as Record<string, unknown>;
    const fn = record.function;
    if (!fn || typeof fn !== 'object') {
      throw new Error('openai-compatible tool call is missing function');
    }
    const functionRecord = fn as Record<string, unknown>;
    const name = typeof functionRecord.name === 'string' ? functionRecord.name.trim() : '';
    if (!name) {
      throw new Error('openai-compatible tool call function.name is required');
    }
    const id = typeof record.id === 'string' && record.id.trim()
      ? record.id.trim()
      : `call-${index + 1}`;
    const rawArguments = typeof functionRecord.arguments === 'string' ? functionRecord.arguments : '{}';
    return {
      id,
      name,
      arguments: parseToolArguments(rawArguments),
    };
  });
}

function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) {
    return {};
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('tool call arguments must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

async function generateOpenAiText(
  config: TextProviderConfig,
  request: LlmTextRequest,
): Promise<string> {
  throwIfAborted(request.signal);
  if (!config.apiKey?.trim()) {
    throw new Error('llm.apiKey is required for openai llm provider');
  }

  const apiStyle = normalizeApiStyle(config.api);
  const baseUrl = config.baseUrl ?? (
    apiStyle === 'chatCompletions'
      ? 'https://api.openai.com/v1/chat/completions'
      : 'https://api.openai.com/v1/responses'
  );
  const timeout = withProviderTimeout(request.signal, 'openai text request');
  try {
    const response = await fetch(
      apiStyle === 'chatCompletions' ? normalizeChatCompletionsUrl(baseUrl) : baseUrl,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
        },
        signal: timeout.signal,
        body: JSON.stringify(
          apiStyle === 'chatCompletions'
            ? {
                model: config.model ?? 'gpt-5.4-mini',
                messages: [
                  { role: 'system', content: request.system },
                  { role: 'user', content: request.prompt },
                ],
              }
            : {
                model: config.model ?? 'gpt-5.4-mini',
                input: [
                  {
                    role: 'system',
                    content: [{ type: 'input_text', text: request.system }],
                  },
                  {
                    role: 'user',
                    content: [{ type: 'input_text', text: request.prompt }],
                  },
                ],
              },
        ),
      },
    );

    if (!response.ok) {
      throw new Error(`openai request failed with status ${response.status}: ${await response.text()}`);
    }

    const payload = await response.json() as Record<string, unknown>;
    if (apiStyle === 'chatCompletions') {
      const choices = Array.isArray(payload.choices) ? payload.choices as Array<{ message?: { content?: string } }> : [];
      const content = choices[0]?.message?.content?.trim();
      if (!content) {
        throw new Error('openai-compatible response did not contain text content');
      }
      return content;
    }

    const text = extractResponsesText(payload);
    if (!text) {
      throw new Error('openai response did not contain text output');
    }
    return text;
  } finally {
    timeout.cleanup();
  }
}

async function generateOpenAiCodexText(
  config: TextProviderConfig,
  request: LlmTextRequest,
): Promise<string> {
  throwIfAborted(request.signal);
  const auth = loadCodexCliAuth();
  const timeout = withProviderTimeout(request.signal, 'openai-codex text request');
  try {
    const response = await fetch(normalizeCodexResponsesUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${auth.accessToken}`,
        'content-type': 'application/json',
      },
      signal: timeout.signal,
      body: JSON.stringify({
        model: config.model ?? 'gpt-5.4',
        instructions: request.system,
        store: false,
        stream: true,
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: request.prompt }],
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`openai-codex request failed with status ${response.status}: ${await response.text()}`);
    }

    const text = extractCodexStreamText(await response.text());
    if (!text) {
      throw new Error('openai-codex response did not contain text output');
    }
    return text;
  } finally {
    timeout.cleanup();
  }
}

async function generateOpenAiCodexWithTools(
  config: TextProviderConfig,
  request: LlmToolRequest,
): Promise<LlmToolResult> {
  throwIfAborted(request.signal);
  const auth = loadCodexCliAuth();
  const timeout = withProviderTimeout(request.signal, 'openai-codex tool request');
  try {
    const response = await fetch(normalizeCodexResponsesUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${auth.accessToken}`,
        'content-type': 'application/json',
      },
      signal: timeout.signal,
      body: JSON.stringify({
        model: config.model ?? 'gpt-5.4',
        instructions: codexInstructions(request.messages),
        store: false,
        stream: true,
        input: request.messages.flatMap(toCodexInputItems),
        tools: request.tools.map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
        tool_choice: 'auto',
      }),
    });

    if (!response.ok) {
      throw new Error(`openai-codex request failed with status ${response.status}: ${await response.text()}`);
    }

    const stream = parseCodexStream(await response.text());
    const toolCalls = stream.toolCalls;
    if (toolCalls.length > 0) {
      return { type: 'tool_calls', toolCalls };
    }

    const text = stream.text;
    if (!text) {
      throw new Error('openai-codex response did not contain text output or tool calls');
    }
    return { type: 'final', text };
  } finally {
    timeout.cleanup();
  }
}

function extractCodexStreamText(raw: string): string | null {
  return parseCodexStream(raw).text;
}

function parseCodexStream(raw: string): { text: string | null; toolCalls: LlmToolCall[] } {
  const events = parseSseEvents(raw);
  const deltas: string[] = [];
  let completed: Record<string, unknown> | null = null;
  const directCalls: LlmToolCall[] = [];

  for (const event of events) {
    const type = typeof event.type === 'string' ? event.type : '';
    if (type.endsWith('output_text.delta') && typeof event.delta === 'string') {
      deltas.push(event.delta);
    }
    if (type === 'response.completed' && event.response && typeof event.response === 'object') {
      completed = event.response as Record<string, unknown>;
    }
    const item = event.item;
    if (item && typeof item === 'object') {
      directCalls.push(...parseCodexToolCalls([item]));
    }
  }

  const completedToolCalls = completed ? dedupeToolCalls(parseCodexToolCalls(completed.output)) : [];
  if (completedToolCalls.length > 0) {
    return { text: null, toolCalls: completedToolCalls };
  }
  const dedupedDirectCalls = dedupeToolCalls(directCalls);
  if (dedupedDirectCalls.length > 0) {
    return { text: null, toolCalls: dedupedDirectCalls };
  }

  const completedText = completed ? extractResponsesText(completed) : null;
  const text = completedText || deltas.join('').trim();
  return { text: text || null, toolCalls: [] };
}

function parseSseEvents(raw: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  const chunks = raw.split(/\n\n+/);
  for (const chunk of chunks) {
    const data = chunk
      .split(/\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .join('\n')
      .trim();
    if (!data || data === '[DONE]') {
      continue;
    }
    const parsed = JSON.parse(data) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      events.push(parsed as Record<string, unknown>);
    }
  }
  return events;
}

function codexInstructions(messages: LlmToolMessage[]): string {
  return messages
    .filter((message): message is Extract<LlmToolMessage, { role: 'system' }> => message.role === 'system')
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join('\n\n');
}

function toCodexInputItems(message: LlmToolMessage): Array<Record<string, unknown>> {
  if (message.role === 'system') {
    return [];
  }
  if (message.role === 'assistant') {
    const items: Array<Record<string, unknown>> = [];
    if (message.content?.trim()) {
      items.push({
        role: 'assistant',
        content: [{ type: 'output_text', text: message.content }],
      });
    }
    for (const call of message.toolCalls ?? []) {
      items.push({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      });
    }
    return items;
  }
  if (message.role === 'tool') {
    return [{
      type: 'function_call_output',
      call_id: message.toolCallId,
      output: message.content,
    }];
  }
  return [{
    role: 'user',
    content: [{ type: 'input_text', text: message.content }],
  }];
}

function parseCodexToolCalls(value: unknown): LlmToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const calls: LlmToolCall[] = [];
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.type !== 'function_call') {
      continue;
    }
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!name) {
      throw new Error('openai-codex function_call name is required');
    }
    const id = typeof record.call_id === 'string' && record.call_id.trim()
      ? record.call_id.trim()
      : typeof record.id === 'string' && record.id.trim()
        ? record.id.trim()
        : `call-${index + 1}`;
    calls.push({
      id,
      name,
      arguments: parseToolArguments(typeof record.arguments === 'string' ? record.arguments : '{}'),
    });
  }
  return calls;
}

function dedupeToolCalls(calls: LlmToolCall[]): LlmToolCall[] {
  const byId = new Map<string, LlmToolCall>();
  for (const call of calls) {
    const existing = byId.get(call.id);
    byId.set(call.id, preferToolCall(existing, call));
  }
  return [...byId.values()];
}

function preferToolCall(existing: LlmToolCall | undefined, candidate: LlmToolCall): LlmToolCall {
  if (!existing) {
    return candidate;
  }
  const existingEmpty = Object.keys(existing.arguments).length === 0;
  const candidateEmpty = Object.keys(candidate.arguments).length === 0;
  if (!candidateEmpty || existingEmpty) {
    return candidate;
  }
  return existing;
}

function normalizeApiStyle(api?: string): 'responses' | 'chatCompletions' {
  if (api === 'openai-completions' || api === 'chat_completions' || api === 'chat-completions') {
    return 'chatCompletions';
  }
  return 'responses';
}

function normalizeChatCompletionsUrl(baseUrl: string): string {
  return baseUrl.endsWith('/chat/completions')
    ? baseUrl
    : `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

function normalizeCodexResponsesUrl(baseUrl?: string): string {
  const resolved = (baseUrl ?? 'https://chatgpt.com/backend-api').replace(/\/+$/, '');
  if (resolved === 'https://chatgpt.com/backend-api' || resolved === 'https://chatgpt.com/backend-api/responses') {
    return 'https://chatgpt.com/backend-api/codex/responses';
  }
  return resolved.endsWith('/responses')
    ? resolved
    : `${resolved}/responses`;
}

function extractResponsesText(payload: Record<string, unknown>): string | null {
  const outputText = typeof payload.output_text === 'string' ? payload.output_text.trim() : '';
  if (outputText) {
    return outputText;
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  const fragments: string[] = [];
  for (const item of output as Array<{ content?: Array<{ type?: string; text?: string }> }>) {
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && typeof content.text === 'string' && content.text.trim()) {
        fragments.push(content.text);
      }
    }
  }
  return fragments.length > 0 ? fragments.join('\n\n') : null;
}

function extractLabeledValue(input: string, label: string): string | null {
  for (const line of input.split('\n')) {
    if (line.startsWith(label)) {
      return line.slice(label.length).trim();
    }
  }
  return null;
}

function extractBlock(input: string, startLabel: string, endLabel: string): string | null {
  const start = input.indexOf(startLabel);
  if (start < 0) {
    return null;
  }
  const afterStart = input.slice(start + startLabel.length);
  const end = afterStart.indexOf(endLabel);
  return (end >= 0 ? afterStart.slice(0, end) : afterStart).trim();
}

function excerpt(value: string): string {
  const collapsed = value.split(/\s+/).join(' ').trim();
  return collapsed.length > 80 ? `${collapsed.slice(0, 77)}...` : collapsed;
}

function lastUserMessage(messages: LlmToolMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user') {
      return message.content;
    }
  }
  return '';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  const reason = signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }
  const error = new Error('operation aborted');
  error.name = 'AbortError';
  throw error;
}
