import { getTurnLlmConfig } from '../config.js';
import { generateText } from './provider.js';
import { loadPromptTemplate, renderPromptTemplate } from './prompt-loader.js';

const MAX_SUMMARY_CHARS = 1000;

export type ResolvedTurnSummary = {
  title?: string;
  summary?: string;
};

type TurnOutput = {
  title: string;
  summary: string;
};

export async function resolveTurnSummary(params: {
  prompt?: string;
  title?: string;
  summary?: string;
  response?: string;
}): Promise<ResolvedTurnSummary> {
  let title = sanitizeText(params.title);
  let summary = sanitizeText(params.summary);
  const prompt = hasText(params.prompt) ? params.prompt!.trim() : undefined;
  const response = hasText(params.response) ? params.response!.trim() : undefined;

  if (prompt && response) {
    if (!title || !summary) {
      const generated = await generateIfConfigured(prompt, response);
      if (!title && generated?.title) {
        title = generated.title;
      }
      if (!summary && generated?.summary) {
        summary = generated.summary;
      }
    }
    if (!summary) {
      summary = `${prompt}\n\n${response}`;
    }
  }

  return {
    title,
    summary,
  };
}

async function generateIfConfigured(prompt: string, response: string): Promise<TurnOutput | null> {
  const config = getTurnLlmConfig();
  const titleMaxChars = config?.titleMaxChars ?? 100;
  if (config && shouldUseLlmSummary(prompt, response, config.llmSummaryThresholdChars)) {
    try {
      const template = loadPromptTemplate('turn');
      const raw = await generateText('turn', {
        system: renderPromptTemplate(template.system, {
          max_title_chars: titleMaxChars,
          max_summary_chars: MAX_SUMMARY_CHARS,
        }),
        prompt: renderPromptTemplate(template.userTemplate, {
          prompt,
          response,
        }),
      });
      if (raw) {
        const parsed = parseTurnOutput(raw, prompt, response, titleMaxChars);
        if (parsed) {
          return parsed;
        }
      }
    } catch {
      // Fall through to local generation.
    }
  }
  return buildLocalTurn(prompt, response, titleMaxChars);
}

function shouldUseLlmSummary(prompt: string, response: string, thresholdChars: number): boolean {
  return prompt.length + response.length >= thresholdChars;
}

function buildLocalTurn(prompt: string, response: string, titleMaxChars: number): TurnOutput | null {
  const summary = buildDirectSummary(prompt, response);
  if (!summary) {
    return null;
  }
  const title = deriveLocalTitle(prompt, summary, response, titleMaxChars);
  if (!title) {
    return null;
  }
  return { title, summary };
}

function buildDirectSummary(prompt?: string, response?: string): string | null {
  if (!hasText(prompt) || !hasText(response)) {
    return null;
  }
  return `${prompt!.trim()}\n\n${response!.trim()}`;
}

function parseTurnOutput(
  raw: string,
  prompt: string,
  response: string,
  titleMaxChars: number,
): TurnOutput | null {
  const parsed = parseRawTurnOutput(raw);
  const fallbackSummary = buildFallbackSummary(prompt, response);
  const summary = normalizeSummary(parsed?.summary ?? raw, prompt, response)
    ?? normalizeText(fallbackSummary, MAX_SUMMARY_CHARS, false);
  if (!summary) {
    return null;
  }
  const title = deriveLocalTitle(prompt, summary, response, titleMaxChars);
  if (!title) {
    return null;
  }
  return { title, summary };
}

function parseRawTurnOutput(raw: string): { summary?: string } | null {
  try {
    return JSON.parse(raw) as { summary?: string };
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end >= start) {
      try {
        return JSON.parse(raw.slice(start, end + 1)) as { summary?: string };
      } catch {
        return null;
      }
    }
    return null;
  }
}

function normalizeSummary(raw: string, prompt: string, response: string): string | null {
  const normalized = normalizeText(raw, MAX_SUMMARY_CHARS, false);
  if (!normalized) {
    return null;
  }
  if (normalized.includes('User:') && normalized.includes('Agent:')) {
    return normalized;
  }
  if (!normalized.includes('User:') && !normalized.includes('Agent:')) {
    return buildFallbackSummary(prompt, response);
  }
  const userText = excerpt(prompt, 400) || 'No explicit user request captured.';
  const agentText = normalized.includes('Agent:')
    ? (normalized.split('Agent:')[1]?.trim() || excerpt(response, 400))
    : excerpt(response, 400);
  return normalizeText(`User: ${userText} Agent: ${agentText}`, MAX_SUMMARY_CHARS, false);
}

function buildFallbackSummary(prompt: string, response: string): string {
  return buildDirectSummary(prompt, response) ?? excerpt(response, 400);
}

function deriveLocalTitle(
  prompt: string,
  summary: string,
  response: string,
  maxChars: number,
): string | null {
  return normalizeText(prompt, maxChars, true)
    ?? deriveTitleFromSummary(summary, maxChars)
    ?? normalizeText(excerpt(response, maxChars), maxChars, true);
}

function deriveTitleFromSummary(summary: string, maxChars: number): string | null {
  const source = summary.startsWith('User:')
    ? (summary.slice('User:'.length).split('Agent:')[0] ?? '').trim()
    : summary.trim();
  if (!source) {
    return null;
  }
  const boundary = findBoundary(source);
  return normalizeText(source.slice(0, boundary).trim(), maxChars, true);
}

function findBoundary(value: string): number {
  const markers = ['。', '！', '？', '.', '!', '?', ';', '；', ':', '：', ',', '，'];
  const positions = markers.map((marker) => value.indexOf(marker)).filter((index) => index >= 0);
  return positions.length > 0 ? Math.min(...positions) : value.length;
}

function sanitizeText(value?: string): string | undefined {
  return hasText(value) ? value!.trim() : undefined;
}

function normalizeText(raw: string, maxChars: number, trimTrailingPunct: boolean): string | null {
  const collapsed = raw.split(/\s+/).join(' ').trim();
  if (!collapsed) {
    return null;
  }
  const trimmed = trimTrailingPunct
    ? collapsed.replace(/[。！？.!?;；:：,，\s]+$/u, '').trim()
    : collapsed;
  const value = truncateChars(trimmed, maxChars);
  return value || null;
}

function excerpt(value: string, maxChars: number): string {
  return truncateChars(value.trim(), maxChars);
}

function truncateChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 3) {
    return value.slice(0, maxChars);
  }
  return `${value.slice(0, maxChars - 3)}...`;
}

function hasText(value?: string | null): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
