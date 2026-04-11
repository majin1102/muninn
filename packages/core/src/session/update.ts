import type { TurnContent } from '../client.js';
import { resolveTurnMetadata } from '../llm/turn-generator.js';
import type { Session } from './session.js';
import { hasText, normalizeSessionId, sessionKey } from './key.js';
import type { SessionUpdate } from './types.js';

export async function buildSessionUpdate(
  session: Session,
  content: TurnContent,
  observer: string,
  observingEpoch: number,
): Promise<SessionUpdate> {
  validateContent(content);
  const previewPrompt = session.previewPrompt(content.prompt);
  const metadata = await resolveTurnMetadata({
    prompt: previewPrompt,
    title: content.title,
    summary: content.summary,
    response: content.response,
  });
  return {
    sessionId: normalizeSessionId(content.sessionId),
    agent: content.agent,
    observer,
    title: metadata.title,
    summary: metadata.summary,
    titleSource: metadata.titleSource,
    summarySource: metadata.summarySource,
    toolCalling: content.toolCalling,
    artifacts: content.artifacts,
    prompt: content.prompt,
    response: content.response,
    observingEpoch,
  };
}

export function validateContent(content: TurnContent): void {
  const hasContent = Boolean(
    (content.toolCalling && content.toolCalling.length > 0)
      || (content.artifacts && Object.keys(content.artifacts).length > 0)
      || hasText(content.prompt)
      || hasText(content.response),
  );
  if (!hasContent) {
    throw new Error('turn must include at least one message field');
  }
}

export function sessionUpdateKey(update: SessionUpdate): string {
  return sessionKey(update.sessionId, update.agent, update.observer);
}
