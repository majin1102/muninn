import { getObserverLlmConfig, getTurnLlmConfig, type TextProviderConfig } from './config.js';
import { loadCodexCliAuth } from './codex-auth.js';

export type LlmTask = 'turn' | 'observer';

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
  const config = task === 'turn' ? getTurnLlmConfig() : getObserverLlmConfig();
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
  const config = task === 'turn' ? getTurnLlmConfig() : getObserverLlmConfig();
  if (!config) {
    return null;
  }
  if (config.provider === 'mock') {
    return { type: 'final', text: generateMockText({ system: '', prompt: lastUserMessage(request.messages) }) };
  }
  return generateOpenAiWithTools(config, request);
}

function generateMockText(request: LlmTextRequest): string {
  const seed = extractBlock(request.prompt, 'User request:', 'Final response:')
    || extractLabeledValue(request.prompt, 'Final response:')
    || request.prompt.trim();

  if (request.system.includes('routing gateway for an observing memory system')) {
    return JSON.stringify({ workItems: [], ignoredTurnIds: [] });
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
  const response = await fetch(normalizeChatCompletionsUrl(baseUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
    },
    signal: request.signal,
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
  const response = await fetch(
    apiStyle === 'chatCompletions' ? normalizeChatCompletionsUrl(baseUrl) : baseUrl,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      signal: request.signal,
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
}

async function generateOpenAiCodexText(
  config: TextProviderConfig,
  request: LlmTextRequest,
): Promise<string> {
  throwIfAborted(request.signal);
  const auth = loadCodexCliAuth();
  const response = await fetch(normalizeCodexResponsesUrl(config.baseUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${auth.accessToken}`,
      'content-type': 'application/json',
    },
    signal: request.signal,
    body: JSON.stringify({
      model: config.model ?? 'gpt-5.4',
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
    }),
  });

  if (!response.ok) {
    throw new Error(`openai-codex request failed with status ${response.status}: ${await response.text()}`);
  }

  const text = extractResponsesText(await response.json() as Record<string, unknown>);
  if (!text) {
    throw new Error('openai-codex response did not contain text output');
  }
  return text;
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
