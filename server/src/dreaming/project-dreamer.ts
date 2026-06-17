import { getExtractorLlmConfig } from '../config.js';
import { generateText } from '../llm/provider.js';
import { loadPromptTemplate, renderPromptTemplate } from '../llm/prompts.js';
import { validateProjectDreamContent } from './content.js';

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
      const dream = raw.trim();
      validateProjectDreamContent(dream);
      return dream;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError;
}

function mockProjectDream(input: ProjectDreamInput): string {
  const parent = input.parentDream.trim();
  if (parent && parent !== '(none)') {
    return parent;
  }
  return [
    '# Project Dream',
    '',
    '## Signals',
    '',
    '### Guidance',
    input.incrementalSignals.trim(),
    '',
    '### Skills',
    '',
    '### Open Questions',
  ].join('\n').trim();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('operation aborted');
  }
}
