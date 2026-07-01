export type ExtractionTurnLike = {
  turnId: string;
  prompt?: string | null;
  response?: string | null;
};

export type PreviewPolicy = {
  previewChars: number;
  previewHeadChars: number;
  previewTailChars: number;
};

export type RenderedTurnTrace = {
  turnId: string;
  promptCharsOriginal: number;
  promptCharsRendered: number;
  omittedPromptPlanChars: number;
  responseCharsOriginal: number;
  responseCharsRendered: number;
  omittedResponseCompressedChars: number;
  omittedResponseChars: number;
  records: Array<Record<string, unknown>>;
};

export type RenderedBatchTurns = {
  markdown: string;
  renderedChars: number;
  stoppedBy: 'none' | 'new-batch-input-chars' | 'max-epoch-turns' | 'single-turn-oversize';
  turns: RenderedTurnTrace[];
};

export type BatchBudget = {
  newBatchInputChars: number;
  maxEpochTurns: number;
  previewChars: number;
};

const PROPOSED_PLAN_BLOCK_RE = /<proposed_plan>([\s\S]*?)<\/proposed_plan>/g;
const FENCE_RE = /```([^\n`]*)\n([\s\S]*?)```/g;

export function previewPolicy(previewChars: number): PreviewPolicy {
  const previewHeadChars = Math.ceil(previewChars * 0.6);
  return {
    previewChars,
    previewHeadChars,
    previewTailChars: previewChars - previewHeadChars,
  };
}

export function renderCurrentBatchTurns(
  turns: ExtractionTurnLike[],
  options: { previewChars: number; stoppedBy?: RenderedBatchTurns['stoppedBy'] },
): RenderedBatchTurns {
  const renderedTurns = turns.map((turn) => renderTurn(turn, options.previewChars));
  const markdown = [
    '## Current Batch Turns',
    renderedTurns.map((turn) => [
      `### ${turn.turnId}`,
      labeledText('Prompt (instruction signal evidence)', turn.prompt),
      labeledText('Response (workflow context, not instruction signal evidence)', turn.response),
    ].filter(Boolean).join('\n\n')).join('\n\n') || '(empty)',
  ].join('\n');
  return {
    markdown,
    renderedChars: markdown.length,
    stoppedBy: options.stoppedBy ?? 'none',
    turns: renderedTurns.map((turn) => turn.trace),
  };
}

export function chunkTurnsByInputBudget<T extends ExtractionTurnLike>(
  turns: T[],
  budget: BatchBudget,
): Array<{ turns: T[]; stoppedBy: RenderedBatchTurns['stoppedBy'] }> {
  if (turns.length === 0) {
    return [];
  }
  const chunks: Array<{ turns: T[]; stoppedBy: RenderedBatchTurns['stoppedBy'] }> = [];
  let index = 0;
  while (index < turns.length) {
    let chunk: T[] = [];
    let stoppedBy: RenderedBatchTurns['stoppedBy'] = 'none';
    while (index + chunk.length < turns.length) {
      const candidate = [...chunk, turns[index + chunk.length]];
      if (candidate.length > budget.maxEpochTurns) {
        stoppedBy = 'max-epoch-turns';
        break;
      }
      const rendered = renderCurrentBatchTurns(candidate, { previewChars: budget.previewChars });
      if (rendered.renderedChars > budget.newBatchInputChars && chunk.length > 0) {
        stoppedBy = 'new-batch-input-chars';
        break;
      }
      chunk = candidate;
      if (rendered.renderedChars > budget.newBatchInputChars) {
        stoppedBy = 'single-turn-oversize';
        break;
      }
    }
    if (chunk.length === 0) {
      chunk = [turns[index]];
      stoppedBy = 'single-turn-oversize';
    }
    chunks.push({ turns: chunk, stoppedBy });
    index += chunk.length;
  }
  return chunks;
}

function renderTurn(turn: ExtractionTurnLike, previewChars: number): {
  turnId: string;
  prompt?: string;
  response?: string;
  trace: RenderedTurnTrace;
} {
  const records: Array<Record<string, unknown>> = [];
  const promptOriginal = turn.prompt?.trim() ?? '';
  const responseOriginal = turn.response?.trim() ?? '';
  const promptResult = renderPrompt(promptOriginal, turn.turnId, previewChars, records);
  const responseResult = renderResponse(responseOriginal, turn.turnId, previewChars, records);
  return {
    turnId: turn.turnId,
    prompt: promptResult.text || undefined,
    response: responseResult.text || undefined,
    trace: {
      turnId: turn.turnId,
      promptCharsOriginal: promptOriginal.length,
      promptCharsRendered: promptResult.text.length,
      omittedPromptPlanChars: promptResult.omittedPromptPlanChars,
      responseCharsOriginal: responseOriginal.length,
      responseCharsRendered: responseResult.text.length,
      omittedResponseCompressedChars: responseResult.omittedResponseCompressedChars,
      omittedResponseChars: responseResult.omittedResponseChars,
      records,
    },
  };
}

function renderPrompt(
  prompt: string,
  turnId: string,
  previewChars: number,
  records: Array<Record<string, unknown>>,
): { text: string; omittedPromptPlanChars: number } {
  if (!prompt) {
    return { text: '', omittedPromptPlanChars: 0 };
  }
  const policy = previewPolicy(previewChars);
  let omittedPromptPlanChars = 0;
  const text = prompt.replace(PROPOSED_PLAN_BLOCK_RE, (match, inner: string) => {
    if (inner.length <= previewChars) {
      return match;
    }
    const marker = `[prompt plan middle omitted; omittedChars=${inner.length - previewChars}; source turn available with get_turn turnId=${turnId}]`;
    const folded = foldMiddle(inner, policy, marker);
    omittedPromptPlanChars += inner.length - previewChars;
    records.push({
      turnId,
      promptPlanCharsOriginal: inner.length,
      promptPlanCharsRendered: folded.length,
      previewHeadChars: policy.previewHeadChars,
      previewTailChars: policy.previewTailChars,
      omittedPromptPlanChars: inner.length - previewChars,
      reason: 'prompt-proposed-plan-preview',
    });
    return `<proposed_plan>${folded}</proposed_plan>`;
  });
  return { text, omittedPromptPlanChars };
}

function renderResponse(
  response: string,
  turnId: string,
  previewChars: number,
  records: Array<Record<string, unknown>>,
): {
  text: string;
  omittedResponseCompressedChars: number;
  omittedResponseChars: number;
} {
  if (!response) {
    return { text: '', omittedResponseCompressedChars: 0, omittedResponseChars: 0 };
  }
  const compressed = compressResponseBlocks(response, turnId, previewChars, records);
  let text = compressed.text;
  let omittedResponseChars = 0;
  if (text.length > previewChars) {
    const policy = previewPolicy(previewChars);
    const marker = `[response middle omitted; omittedChars=${text.length - previewChars}; source turn available with get_turn turnId=${turnId}]`;
    text = foldMiddle(text, policy, marker);
    omittedResponseChars = compressed.text.length - previewChars;
    records.push({
      turnId,
      responseCharsOriginal: compressed.text.length,
      responseCharsRendered: text.length,
      previewHeadChars: policy.previewHeadChars,
      previewTailChars: policy.previewTailChars,
      omittedResponseChars,
      reason: 'response-preview',
    });
  }
  return {
    text,
    omittedResponseCompressedChars: compressed.omittedChars,
    omittedResponseChars,
  };
}

function compressResponseBlocks(
  response: string,
  turnId: string,
  previewChars: number,
  records: Array<Record<string, unknown>>,
): { text: string; omittedChars: number } {
  const proposed = foldProposedPlanResponse(response, turnId, previewChars, records);
  if (proposed.text !== response) {
    return proposed;
  }
  const draft = foldDraftResponse(response, turnId, previewChars, records);
  const fenced = foldFencedBlocks(draft.text, turnId, previewChars, records);
  return {
    text: fenced.text,
    omittedChars: draft.omittedChars + fenced.omittedChars,
  };
}

function foldProposedPlanResponse(
  response: string,
  turnId: string,
  previewChars: number,
  records: Array<Record<string, unknown>>,
): { text: string; omittedChars: number } {
  const trimmed = response.trimStart();
  if (trimmed.startsWith('<proposed_plan>') && response.length > previewChars) {
    return foldResponseSpan(response, turnId, previewChars, 'proposed-plan', records);
  }
  const match = /<proposed_plan>([\s\S]*?)<\/proposed_plan>/.exec(response);
  if (!match || match[1].length <= response.length / 2 || match[0].length <= previewChars) {
    return { text: response, omittedChars: 0 };
  }
  const folded = foldSpan(response, match.index, match.index + match[0].length, turnId, previewChars, 'proposed-plan', records);
  return folded;
}

function foldDraftResponse(
  response: string,
  turnId: string,
  previewChars: number,
  records: Array<Record<string, unknown>>,
): { text: string; omittedChars: number } {
  if (/^\s*PLEASE IMPLEMENT THIS PLAN\b/.test(response) && response.length > previewChars) {
    return foldResponseSpan(response, turnId, previewChars, 'draft-or-spec', records);
  }
  return foldMarkdownDraftSections(response, turnId, previewChars, records);
}

function foldMarkdownDraftSections(
  response: string,
  turnId: string,
  previewChars: number,
  records: Array<Record<string, unknown>>,
): { text: string; omittedChars: number } {
  const headingRe = /^(#{1,6})\s+.*(?:prompt|spec|doc|test[- ]?plan|review draft).*$\n?/gim;
  const matches = [...response.matchAll(headingRe)];
  if (matches.length === 0) {
    return { text: response, omittedChars: 0 };
  }
  let text = response;
  let omittedChars = 0;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    const start = match.index ?? 0;
    const level = match[1].length;
    const end = nextHeadingIndex(response, start + match[0].length, level);
    if (end - start <= previewChars) {
      continue;
    }
    const folded = foldSpan(text, start, end, turnId, previewChars, 'draft-or-spec', records);
    text = folded.text;
    omittedChars += folded.omittedChars;
  }
  return { text, omittedChars };
}

function foldFencedBlocks(
  response: string,
  turnId: string,
  previewChars: number,
  records: Array<Record<string, unknown>>,
): { text: string; omittedChars: number } {
  const matches = [...response.matchAll(FENCE_RE)];
  if (matches.length === 0) {
    return { text: response, omittedChars: 0 };
  }
  let text = response;
  let omittedChars = 0;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    const start = match.index ?? 0;
    const block = match[0];
    if (block.length <= previewChars) {
      continue;
    }
    const lang = (match[1] ?? '').trim().toLowerCase();
    const body = match[2] ?? '';
    const introducedAsDraft = /(?:prompt|spec|doc|test[- ]?plan|review draft)\s*[:：]?\s*$/i
      .test(response.slice(Math.max(0, start - 120), start));
    const reason = introducedAsDraft
      ? 'draft-or-spec'
      : classifyFence(lang, body);
    if (!reason) {
      continue;
    }
    const folded = foldSpan(text, start, start + block.length, turnId, previewChars, reason, records);
    text = folded.text;
    omittedChars += folded.omittedChars;
  }
  return { text, omittedChars };
}

function classifyFence(lang: string, body: string): 'code-fence' | 'diff-log-or-command-output' | null {
  const normalized = body.trimStart();
  if (lang === 'diff' || /^diff --git\b|^@@\s/m.test(normalized)) {
    return 'diff-log-or-command-output';
  }
  if (/^(?:text|bash|sh|shell|console|output|log)$/.test(lang)
    && /(?:error|failed|passed|traceback|stack trace|npm ERR|pnpm|cargo|pytest|vitest|make:|\$ )/i.test(body)) {
    return 'diff-log-or-command-output';
  }
  if (lang) {
    return 'code-fence';
  }
  return null;
}

function foldResponseSpan(
  response: string,
  turnId: string,
  previewChars: number,
  reason: string,
  records: Array<Record<string, unknown>>,
): { text: string; omittedChars: number } {
  return foldSpan(response, 0, response.length, turnId, previewChars, reason, records);
}

function foldSpan(
  text: string,
  start: number,
  end: number,
  turnId: string,
  previewChars: number,
  reason: string,
  records: Array<Record<string, unknown>>,
): { text: string; omittedChars: number } {
  const span = text.slice(start, end);
  const policy = previewPolicy(previewChars);
  const omittedChars = Math.max(0, span.length - previewChars);
  const marker = `[response block middle omitted; reason=${reason}; omittedChars=${omittedChars}; source turn available with get_turn turnId=${turnId}]`;
  const foldedSpan = foldMiddle(span, policy, marker);
  records.push({
    turnId,
    responseCharsOriginal: span.length,
    responseCharsRendered: foldedSpan.length,
    previewHeadChars: policy.previewHeadChars,
    previewTailChars: policy.previewTailChars,
    omittedResponseCompressedChars: omittedChars,
    reason,
  });
  return {
    text: `${text.slice(0, start)}${foldedSpan}${text.slice(end)}`,
    omittedChars,
  };
}

function foldMiddle(text: string, policy: PreviewPolicy, marker: string): string {
  if (text.length <= policy.previewChars) {
    return text;
  }
  return [
    text.slice(0, policy.previewHeadChars),
    marker,
    text.slice(text.length - policy.previewTailChars),
  ].join('\n');
}

function nextHeadingIndex(text: string, start: number, currentLevel: number): number {
  const headingRe = /^(#{1,6})\s+/gm;
  headingRe.lastIndex = start;
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(text)) !== null) {
    if (match[1].length <= currentLevel) {
      return match.index;
    }
  }
  return text.length;
}

function labeledText(label: string, value?: string | null): string | null {
  const text = value?.trim();
  return text ? `${label}:\n${text}` : null;
}
