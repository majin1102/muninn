import { getExtractorLlmConfig } from '../config.js';
import {
  generateWithTools,
  type LlmTask,
  type LlmToolRequest,
  type LlmToolResult,
} from '../llm/provider.js';
import { loadPromptTemplate, renderPromptTemplate } from '../llm/prompts.js';
import {
  normalizeProjectDreamContent,
  type ProjectDreamLabelSet,
} from './content.js';

export type ProjectDreamInput = {
  project: string;
  existingProjectSignals: string;
  incrementalSessionSignals: string;
  labels?: ProjectDreamLabelSet;
};

export type ProjectDreamModel = (
  task: LlmTask,
  request: LlmToolRequest,
) => Promise<LlmToolResult | null>;

export function buildProjectDreamPrompt(input: ProjectDreamInput): string {
  const template = loadPromptTemplate('project_dreaming');
  return renderPromptTemplate(template.userTemplate, {
    project: input.project,
    existing_project_signals: input.existingProjectSignals.trim() || '(none)',
    incremental_session_signals: input.incrementalSessionSignals.trim() || '(none)',
  });
}

export async function mergeProjectDream(input: ProjectDreamInput & {
  signal?: AbortSignal;
  model?: ProjectDreamModel;
}): Promise<string> {
  const template = loadPromptTemplate('project_dreaming');
  const config = getExtractorLlmConfig();
  if (!config) {
    throw new Error('extraction update is not configured');
  }
  if (config.provider === 'mock') {
    return mockProjectDream(input);
  }

  const model = input.model ?? generateWithTools;
  const system = renderPromptTemplate(template.system, { project: input.project });
  const basePrompt = buildProjectDreamPrompt(input);
  let lastError = new Error('project signal merge returned no output');

  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    throwIfAborted(input.signal);
    const prompt = attempt === 1
      ? basePrompt
      : `${basePrompt}\n\nPrevious output was invalid. Validation error: ${lastError.message} Return only a valid project signal Markdown document.`;
    try {
      const raw = await model('extractor', {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        tools: [],
        signal: input.signal,
      });
      if (!raw || raw.type !== 'final' || !raw.text.trim()) {
        lastError = new Error('project signal merge returned no output');
        continue;
      }
      return normalizeProjectDreamContent(raw.text, input.labels);
    } catch (error) {
      if (isFatalModelError(error, input.signal)) {
        throw error;
      }
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError;
}

function mockProjectDream(input: ProjectDreamInput): string {
  const text = [
    '# Project Signals',
    '',
    input.existingProjectSignals.trim(),
    '',
    input.incrementalSessionSignals.trim(),
  ]
    .join('\n')
    .trim();
  return normalizeProjectDreamContent(text === '# Project Signals' ? '# Project Signals' : text, input.labels);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('operation aborted');
  }
}

function isFatalModelError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\bllm (?:tool )?request failed\b/i.test(message);
}
