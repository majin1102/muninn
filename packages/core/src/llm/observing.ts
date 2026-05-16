import { parseObserverDocument } from '../observer/markdown.js';
import type { ParsedObserverDocument } from '../observer/types.js';
import { getObserverRuntimeConfig } from '../config.js';
import { generateText } from './provider.js';
import { loadPromptTemplate, renderPromptTemplate } from './prompt-loader.js';

export type ObserverExtractionInput = {
  id: string;
  text: string;
  context?: string | null;
  anchors?: string[];
  turnRefs?: string[];
};

export type ObserveAnchorInput = {
  entityAnchor: string;
  content: string;
  extractions: ObserverExtractionInput[];
  maxAttempts?: number;
  signal?: AbortSignal;
};

export async function observeAnchor(input: ObserveAnchorInput): Promise<ParsedObserverDocument> {
  const template = loadPromptTemplate('thread_observing');
  const contentBudgetChars = getObserverRuntimeConfig().contentBudgetChars;
  const content = trimContent(input.content, contentBudgetChars);
  const prompt = renderPromptTemplate(template.userTemplate, {
    entity_anchor: input.entityAnchor,
    content: content.trim() || '(none)',
    extractions: renderExtractions(input.extractions),
  });
  const validRefs = new Set([
    ...extractRefs(input.content),
    ...input.extractions.map((extraction) => extraction.id),
  ]);
  const attempts = input.maxAttempts ?? 2;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfAborted(input.signal);
    const raw = await generateText('observer', {
      system: template.system,
      prompt: attempt === 1 ? prompt : `${prompt}\n\nPrevious output was invalid: ${String(lastError)}\nReturn Markdown only.`,
      signal: input.signal,
    });
    if (!raw) {
      throw new Error('observer llm is unavailable');
    }
    try {
      return parseObserverDocument(raw, validRefs);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function renderExtractions(extractions: ObserverExtractionInput[]): string {
  return extractions.map((extraction) => [
    `- ${extraction.id}`,
    extraction.anchors && extraction.anchors.length > 0 ? `  Anchors: ${extraction.anchors.join('; ')}` : '',
    extraction.context?.trim() ? `  Context: ${extraction.context.trim()}` : '',
    `  Extraction: ${extraction.text.trim()}`,
    extraction.turnRefs && extraction.turnRefs.length > 0 ? `  Source refs: ${extraction.turnRefs.join(', ')}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
}

function trimContent(content: string, maxChars: number): string {
  const value = content.trim();
  if (value.length <= maxChars) {
    return value;
  }
  const marker = '\n\n<!-- Existing content omitted to keep observer input bounded. -->\n\n';
  const headBudget = Math.min(Math.floor(maxChars * 0.25), 4_000);
  const tailBudget = Math.max(maxChars - headBudget - marker.length, 0);
  return `${value.slice(0, headBudget).trimEnd()}${marker}${value.slice(-tailBudget).trimStart()}`;
}

function extractRefs(content: string): string[] {
  return [...content.matchAll(/refs:\s*\[([^\]]+)\]/g)]
    .flatMap((match) => (match[1] ?? '').split(',').map((ref) => ref.trim()).filter(Boolean));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Operation aborted', 'AbortError');
  }
}

export const __testing = {
  renderExtractions,
  trimContent,
};
