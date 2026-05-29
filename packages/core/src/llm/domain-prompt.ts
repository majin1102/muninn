import { loadPromptTemplate } from './prompt-loader.js';

export function loadDomainPrompt(name?: string): string | undefined {
  if (!name) {
    return undefined;
  }
  if (name !== 'chat') {
    throw new Error(`unsupported observer.domainPrompt: ${name}`);
  }
  return extractSection(loadPromptTemplate('chat').system, 'Chat memory categories');
}

export function loadGatewayDomainPrompt(name?: string): string | undefined {
  if (!name) {
    return undefined;
  }
  if (name !== 'chat') {
    throw new Error(`unsupported observer.domainPrompt: ${name}`);
  }
  return extractSection(loadPromptTemplate('chat').system, 'Observing thread definition', [
    'Chat memory categories',
  ]);
}

function extractSection(prompt: string, heading: string, stopHeadings: string[] = []): string {
  const markerPattern = `${escapeRegExp(heading)}:?`;
  const start = prompt.search(new RegExp(`^${markerPattern}$`, 'm'));
  if (start < 0) {
    throw new Error(`missing ${heading} section in chat domain prompt`);
  }
  const matched = prompt.slice(start).match(new RegExp(`^${markerPattern}$`, 'm'));
  const markerLength = matched?.[0]?.length ?? heading.length;

  let end = prompt.length;
  for (const stopHeading of stopHeadings) {
    const stopMarkerPattern = `${escapeRegExp(stopHeading)}:?`;
    const stop = prompt
      .slice(start + markerLength)
      .search(new RegExp(`^${stopMarkerPattern}$`, 'm'));
    if (stop >= 0) {
      end = Math.min(end, start + markerLength + stop);
    }
  }

  return prompt.slice(start, end).trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
