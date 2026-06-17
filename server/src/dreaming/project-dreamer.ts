import { getExtractorLlmConfig } from '../config.js';
import { generateText } from '../llm/provider.js';
import { loadPromptTemplate, renderPromptTemplate } from '../llm/prompts.js';
import { normalizeProjectDreamContent, validateProjectDreamContent } from './content.js';

export type ProjectDreamInput = {
  project: string;
  parentDream: string;
  incrementalSignals: string;
};

export type ProjectDreamModel = (request: {
  system: string;
  prompt: string;
  signal?: AbortSignal;
}) => Promise<string | null>;

export function buildProjectDreamPrompt(input: ProjectDreamInput): string {
  const template = loadPromptTemplate('project_dreaming');
  return renderPromptTemplate(template.userTemplate, {
    project: input.project,
    parent_dream: input.parentDream || '(none)',
    incremental_signals: input.incrementalSignals,
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
    const dream = mockProjectDream(input);
    validateProjectDreamContent(dream);
    return dream;
  }

  const model = input.model ?? ((request) => generateText('extractor', request));
  const basePrompt = buildProjectDreamPrompt(input);
  let lastError = new Error('project dream merge returned no output');

  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    throwIfAborted(input.signal);
    const prompt = attempt === 1
      ? basePrompt
      : `${basePrompt}\n\nPrevious output was invalid. Validation error: ${lastError.message} Return only a valid project dream Markdown document.`;
    const raw = await model({
      system: template.system,
      prompt,
      signal: input.signal,
    });
    if (!raw) {
      lastError = new Error('project dream merge returned no output');
      continue;
    }
    try {
      const dream = normalizeProjectDreamContent(raw);
      validateProjectDreamContent(dream);
      return dream;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError;
}

function mockProjectDream(input: ProjectDreamInput): string {
  const incremental = input.incrementalSignals.trim();
  const parent = input.parentDream.trim();
  if (parent && parent !== '(none)') {
    const dream = incremental
      ? appendGuidance(normalizeProjectDreamContent(parent), incremental)
      : normalizeProjectDreamContent(parent);
    validateProjectDreamContent(dream);
    return dream;
  }
  const dream = [
    '# Project Dream',
    '',
    '## Signals',
    '',
    '### Guidance',
    incremental,
    '',
    '### Skills',
    '',
    '### Open Questions',
  ].join('\n').trim();
  validateProjectDreamContent(dream);
  return dream;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('operation aborted');
  }
}

function appendGuidance(parent: string, incremental: string): string {
  const lines = parent.split('\n');
  const guidance = lines.findIndex((line) => line === '### Guidance');
  const nextSection = lines.findIndex((line, index) => index > guidance && line.startsWith('### '));
  const insertAt = nextSection < 0 ? lines.length : nextSection;
  const before = trimTrailingBlank(lines.slice(0, insertAt));
  const after = trimLeadingBlank(lines.slice(insertAt));
  return [
    ...before,
    ...incremental.split('\n'),
    '',
    ...after,
  ].join('\n').trim();
}

function trimTrailingBlank(lines: string[]): string[] {
  const next = [...lines];
  while (next.length > 0 && next[next.length - 1].trim() === '') {
    next.pop();
  }
  return next;
}

function trimLeadingBlank(lines: string[]): string[] {
  const next = [...lines];
  while (next.length > 0 && next[0].trim() === '') {
    next.shift();
  }
  return next;
}
