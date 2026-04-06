import { getObserverLlmConfig, getTurnLlmConfig, type TextProviderConfig } from './config.js';

export type LlmTask = 'turn' | 'observer';

export type LlmTextRequest = {
  system: string;
  prompt: string;
};

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
  return generateOpenAiText(config, request);
}

function generateMockText(request: LlmTextRequest): string {
  const seed = extractBlock(request.prompt, 'User request:', 'Final response:')
    || extractLabeledValue(request.prompt, 'Final response:')
    || request.prompt.trim();

  if (request.system.includes('routing gateway for an observing memory system')) {
    return JSON.stringify({ updates: [] });
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

async function generateOpenAiText(
  config: TextProviderConfig,
  request: LlmTextRequest,
): Promise<string> {
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
  if (fragments.length === 0) {
    throw new Error('openai response did not contain text output');
  }
  return fragments.join('\n\n');
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
