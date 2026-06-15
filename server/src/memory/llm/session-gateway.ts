import type { Turn } from '../backend.js';
import { getExtractorLlmConfig } from '../config.js';
import type {
  GatewayResult,
  SessionMemoryThreadGatewayInput,
} from '../extractor/types.js';
import { loadGatewayDomainPrompt } from './domain-prompt.js';
import { loadPromptTemplate, renderPromptTemplate } from './prompt-loader.js';
import { generateText } from './provider.js';

const MAX_SUMMARY_CHARS = 220;

export async function routeSessionMemoryThreads(
  sessionMemoryThreads: SessionMemoryThreadGatewayInput[],
  pendingTurns: Turn[],
  signal?: AbortSignal,
): Promise<GatewayResult> {
  throwIfAborted(signal);
  const config = getExtractorLlmConfig();
  if (!config) {
    throw new Error('extractor gateway is not configured');
  }

  const gatewayTurns = toGatewayTurns(pendingTurns);

  if (config.provider === 'mock') {
    return validateGatewayResult(
      sessionMemoryThreads,
      gatewayTurns,
      buildMockGatewayResult(sessionMemoryThreads, gatewayTurns),
    );
  }

  const template = loadPromptTemplate('extracting_gateway');
  const inputJson = JSON.stringify(
    {
      sessionMemoryThreads: sessionMemoryThreads.map((thread) => ({
        threadId: thread.threadId,
        kind: thread.kind,
        title: thread.title,
        summary: thread.summary,
      })),
      pendingTurns: gatewayTurns.map((turn) => ({
        turnId: turn.turnId,
        text: turn.text,
      })),
    },
    null,
    2,
  );
  const systemPrompt = buildGatewaySystemPrompt(config.domainPrompt);
  const basePrompt = renderPromptTemplate(template.userTemplate, { input_json: inputJson });

  let lastError = 'extractor gateway returned no output';
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    throwIfAborted(signal);
    const raw = await generateText('extractor', {
      system: systemPrompt,
      prompt: buildRetryPrompt(
        basePrompt,
        attempt,
        lastError,
        'Make sure every sessionFragment has threadId, turnIds, content, and reason.',
      ),
      signal,
    });
    if (!raw) {
      throw new Error('extractor gateway is not configured');
    }
    throwIfAborted(signal);

    try {
      const parsed = parseJson<GatewayResult>(raw);
      return validateGatewayResult(sessionMemoryThreads, gatewayTurns, parsed);
    } catch (error) {
      lastError = String(error);
    }
  }

  throw new Error(`extractor gateway returned invalid output: ${lastError}`);
}

function toGatewayTurns(pendingTurns: Turn[]): Array<{ turnId: string; text: string }> {
  return pendingTurns.map((turn) => ({
    turnId: turn.turnId,
    text: renderGatewayTurnText(turn),
  }));
}

function renderGatewayTurnText(turn: Turn): string {
  const parts = [
    labeledText('Prompt', turn.prompt),
    labeledText('Response', turn.response),
  ].filter(Boolean);
  if (parts.length > 0) {
    return parts.join('\n\n');
  }
  return turn.summary ?? '';
}

function labeledText(label: string, value?: string | null): string | null {
  const text = value?.trim();
  return text ? `${label}:\n${text}` : null;
}

function buildGatewaySystemPrompt(domainPrompt?: string): string {
  const template = loadPromptTemplate('extracting_gateway');
  return renderPromptTemplate(template.system, {
    domain_prompt: loadGatewayDomainPrompt(domainPrompt)?.trim() || 'No additional domain thread guidance.',
  });
}

function buildMockGatewayResult(
  sessionMemoryThreads: SessionMemoryThreadGatewayInput[],
  pendingTurns: Array<{ turnId: string; text: string }>,
): GatewayResult {
  const targetThread = sessionMemoryThreads.find((thread) => thread.kind === 'session') ?? sessionMemoryThreads[0];
  return {
    sessionFragments: targetThread
      ? pendingTurns.map((turn) => ({
          threadId: targetThread.threadId,
          turnIds: [turn.turnId],
          content: normalizeText(turn.text, MAX_SUMMARY_CHARS),
          reason: 'The turn is routed to the existing session memory thread for inspection.',
        }))
      : [],
  };
}

function validateGatewayResult(
  sessionMemoryThreads: SessionMemoryThreadGatewayInput[],
  pendingTurns: Array<{ turnId: string; text: string }>,
  result: GatewayResult,
): GatewayResult {
  const validTurnIds = new Set(pendingTurns.map((turn) => turn.turnId));
  const validThreadIds = new Set(sessionMemoryThreads.map((thread) => thread.threadId));
  if (!Array.isArray(result.sessionFragments)) {
    throw new Error('extractor gateway returned sessionFragments that are not an array');
  }
  const sessionFragments = result.sessionFragments.map((fragment) => {
    const threadId = typeof fragment.threadId === 'string' ? fragment.threadId.trim() : '';
    if (!validThreadIds.has(threadId)) {
      throw new Error(`extractor gateway referenced unknown threadId: ${threadId}`);
    }
    const turnIds = Array.isArray(fragment.turnIds)
      ? [...new Set(fragment.turnIds.map((turnId) => typeof turnId === 'string' ? turnId.trim() : '').filter(Boolean))]
      : [];
    if (turnIds.length === 0) {
      throw new Error('extractor gateway sessionFragment must include turnIds');
    }
    for (const turnId of turnIds) {
      if (!validTurnIds.has(turnId)) {
        throw new Error(`extractor gateway referenced unknown turnId: ${turnId}`);
      }
    }
    const content = normalizeText(typeof fragment.content === 'string' ? fragment.content : '');
    if (!content) {
      throw new Error('extractor gateway returned empty content');
    }
    const reason = normalizeText(fragment.reason ?? '', MAX_SUMMARY_CHARS);
    if (!reason) {
      throw new Error('extractor gateway returned empty reason');
    }
    return {
      threadId,
      turnIds,
      content,
      reason,
    };
  });
  return { sessionFragments };
}

function parseJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end >= start) {
      return JSON.parse(raw.slice(start, end + 1)) as T;
    }
    throw new Error('invalid JSON');
  }
}

function buildRetryPrompt(
  basePrompt: string,
  attempt: number,
  lastError: string,
  rule: string,
): string {
  if (attempt === 1) {
    return basePrompt;
  }
  return `${basePrompt}\n\nPrevious output was invalid.\nValidation error: ${lastError}\n${rule}`;
}

function normalizeText(value: string, maxChars?: number): string {
  const collapsed = value.split(/\s+/).join(' ').trim();
  if (!collapsed) {
    return '';
  }
  if (maxChars === undefined) {
    return collapsed;
  }
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  if (maxChars <= 3) {
    return collapsed.slice(0, maxChars);
  }
  return `${collapsed.slice(0, maxChars - 3)}...`;
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

export const __testing = {
  buildGatewaySystemPromptForTests: buildGatewaySystemPrompt,
  gatewayTurnsForTests: toGatewayTurns,
  validateGatewayResultForTests: validateGatewayResult,
};
