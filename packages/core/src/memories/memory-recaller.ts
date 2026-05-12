import { generateText } from '../llm/provider.js';
import { loadPromptTemplate, renderPromptTemplate } from '../llm/prompt-loader.js';

export type MemoryRecallCandidate = {
  memoryId: string;
  content: string;
  context?: string | null;
  anchors?: string[];
  refs: string[];
};

export type MemoryRecallInput = {
  query: string;
  budget: number;
  candidates: MemoryRecallCandidate[];
};

export type MemoryRecallResult = {
  content: string;
  refs: string[];
};

export async function recallMemoryContext(input: MemoryRecallInput): Promise<MemoryRecallResult> {
  const template = loadPromptTemplate('memory_recaller');
  const prompt = renderPromptTemplate(template.userTemplate, {
    query: input.query,
    budget: input.budget,
    candidates: renderCandidates(input.candidates),
  });
  const attempts = 2;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const raw = await generateText('observer', {
        system: template.system,
        prompt,
      });
      if (!raw) {
        throw new Error('memory recaller llm is unavailable');
      }
      return validateMemoryRecallResult(parseMemoryRecallJson(raw), input);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function validateMemoryRecallResult(
  result: MemoryRecallResult,
  input: MemoryRecallInput,
): MemoryRecallResult {
  const content = result.content.trim();
  if (!content) {
    throw new Error('memory recaller returned empty content');
  }
  const maxLength = input.budget * 2;
  if (content.length > maxLength) {
    throw new Error(`memory recaller content exceeds soft budget limit: ${content.length} > ${maxLength}`);
  }
  const refs = uniqueStrings(result.refs);
  return { content, refs };
}

function parseMemoryRecallJson(raw: string): MemoryRecallResult {
  const parsed = JSON.parse(stripJsonFence(raw)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('memory recaller result must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.content !== 'string') {
    throw new Error('memory recaller result.content must be a string');
  }
  if (!Array.isArray(record.refs)) {
    throw new Error('memory recaller result.refs must be an array');
  }
  return {
    content: record.content,
    refs: record.refs.map((ref) => String(ref).trim()).filter(Boolean),
  };
}

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function renderCandidates(candidates: MemoryRecallCandidate[]): string {
  return candidates.map((candidate, index) => [
    `[${index + 1}] ${candidate.memoryId}`,
    candidate.anchors && candidate.anchors.length > 0 ? `Anchors: ${candidate.anchors.join('; ')}` : '',
    `Content: ${candidate.content}`,
    candidate.context?.trim() ? `Context: ${candidate.context.trim()}` : '',
    `Refs: ${candidate.refs.join(', ')}`,
  ].filter(Boolean).join('\n')).join('\n\n');
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    output.push(value);
  }
  return output;
}
