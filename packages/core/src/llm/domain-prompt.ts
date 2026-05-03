import { loadPromptTemplate } from './prompt-loader.js';

export function loadDomainPrompt(name?: string): string | undefined {
  if (!name) {
    return undefined;
  }
  if (name !== 'chat') {
    throw new Error(`unsupported observer.domainPrompt: ${name}`);
  }
  return loadPromptTemplate('chat').system;
}
