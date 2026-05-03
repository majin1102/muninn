import fs from 'node:fs';
import path from 'node:path';

type PromptTemplate = {
  system: string;
  userTemplate: string;
};

const promptCache = new Map<string, PromptTemplate>();
const PROMPT_FILE_NAMES = {
  turn: 'turn',
  chat: 'chat',
  thread_observing: 'thread-observing',
  observing_gateway: 'observing-gateway',
  observation_extraction: 'observation-extraction',
  observation_review: 'observation-review',
  thread_preparation: 'thread-preparation',
} as const;

export function loadPromptTemplate(name: keyof typeof PROMPT_FILE_NAMES): PromptTemplate {
  const cached = promptCache.get(name);
  if (cached) {
    return cached;
  }

  const filePath = path.resolve(__dirname, '..', '..', 'prompts', `${PROMPT_FILE_NAMES[name]}.yaml`);
  const raw = fs.readFileSync(filePath, 'utf8');
  const template = {
    system: readYamlBlock(raw, 'system'),
    userTemplate: readYamlBlock(raw, 'user_template'),
  };
  promptCache.set(name, template);
  return template;
}

export function renderPromptTemplate(
  template: string,
  values: Record<string, string | number | undefined>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = values[key];
    return value === undefined ? '' : String(value);
  });
}

function readYamlBlock(raw: string, key: string): string {
  const marker = `${key}: |`;
  const start = raw.indexOf(marker);
  if (start < 0) {
    throw new Error(`missing ${key} block in prompt template`);
  }
  const lines = raw.slice(start + marker.length).split('\n');
  const collected: string[] = [];
  for (const line of lines) {
    if (line.startsWith('  ')) {
      collected.push(line.slice(2));
      continue;
    }
    if (line.trim() === '') {
      collected.push('');
      continue;
    }
    break;
  }
  return collected.join('\n').trimEnd();
}
