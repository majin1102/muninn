import { parseCurationDocument } from '../curation/markdown.js';
import type { ParsedCurationDocument } from '../curation/types.js';
import { generateText } from './provider.js';
import { loadPromptTemplate, renderPromptTemplate } from './prompt-loader.js';

export type CurationExtractionInput = {
  id: string;
  text: string;
  context?: string | null;
  anchors?: string[];
  references?: string[];
};

export type CurateInput = {
  entityAnchor: string;
  content: string;
  extractions: CurationExtractionInput[];
  maxAttempts?: number;
  signal?: AbortSignal;
};

export async function curate(input: CurateInput): Promise<ParsedCurationDocument> {
  const template = loadPromptTemplate('thread_curating');
  const prompt = renderPromptTemplate(template.userTemplate, {
    entity_anchor: input.entityAnchor,
    content: input.content.trim() || '(none)',
    extractions: renderExtractions(input.extractions),
  });
  const validRefs = new Set(input.extractions.map((extraction) => extractionMemoryId(extraction.id)));
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
      throw new Error('curation llm is unavailable');
    }
    try {
      return parseCurationDocument(raw, validRefs);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function renderExtractions(extractions: CurationExtractionInput[]): string {
  return extractions.map((extraction) => [
    `- ${extractionMemoryId(extraction.id)}`,
    extraction.anchors && extraction.anchors.length > 0 ? `  Anchors: ${extraction.anchors.join('; ')}` : '',
    extraction.context?.trim() ? `  Context: ${extraction.context.trim()}` : '',
    `  Extraction: ${extraction.text.trim()}`,
    extraction.references && extraction.references.length > 0 ? `  Source refs: ${extraction.references.join(', ')}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
}

function extractionMemoryId(id: string): string {
  const trimmed = id.trim();
  return trimmed.startsWith('extraction:') ? trimmed : `extraction:${trimmed}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Operation aborted', 'AbortError');
  }
}

export const __testing = {
  renderExtractions,
};
