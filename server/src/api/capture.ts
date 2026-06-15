import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  getCaptureConfigFromConfig,
  isCanonicalProjectIdentity,
  parseMuninnConfigContent,
  resolveMuninnConfigPath,
  type CaptureConfig,
  type MuninnConfigRecord,
} from '../config.js';
export { captureTurn, captureTurns } from '../backend.js';

type JsonObject = Record<string, unknown>;

/**
 * Per-agent, per-project capture settings. Session counts still come from
 * SessionIndex; this module only reads/writes the capture section in muninn.json.
 */
function resolveConfigPath(): string {
  return resolveMuninnConfigPath();
}

type MutableConfigRoot = MuninnConfigRecord & JsonObject;

async function readConfigRoot(): Promise<MutableConfigRoot> {
  try {
    const content = await readFile(resolveConfigPath(), 'utf8');
    return parseMuninnConfigContent(content) as MutableConfigRoot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return defaultConfigRoot() as MutableConfigRoot;
    }
    throw error;
  }
}

async function writeConfigRoot(root: JsonObject): Promise<void> {
  const file = resolveConfigPath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(root, null, 2)}\n`);
}

export async function getCapturePolicy(agent: string): Promise<Record<string, boolean>> {
  const config = await readCaptureConfig();
  return { ...(config.projects[agent] ?? {}) };
}

export async function isAgentCaptureEnabled(agent: string): Promise<boolean> {
  const config = await readCaptureConfig();
  return config.agents[agent] !== false;
}

export async function isCaptureEnabled(agent: string, projectKey: string): Promise<boolean> {
  if (!isCanonicalProjectIdentity(projectKey)) {
    return false;
  }
  const config = await readCaptureConfig();
  return config.agents[agent] !== false && config.projects[agent]?.[projectKey] === true;
}

export async function setAgentCaptureEnabled(agent: string, enabled: boolean): Promise<void> {
  const root = await readConfigRoot();
  const capture = ensureCapture(root);
  const agents = ensureRecord(capture, 'agents');
  agents[agent] = enabled;
  await writeConfigRoot(root);
}

export async function setCaptureEnabled(agent: string, projectKey: string, enabled: boolean): Promise<void> {
  if (!isCanonicalProjectIdentity(projectKey)) {
    throw new Error(`project must be a canonical project identity: ${projectKey}`);
  }
  const root = await readConfigRoot();
  const capture = ensureCapture(root);
  const projects = ensureRecord(capture, 'projects');
  const forAgent = ensureRecord(projects, agent);
  forAgent[projectKey] = enabled;
  await writeConfigRoot(root);
}

export async function removeCapturePolicy(agent: string, projectKey: string): Promise<void> {
  const root = await readConfigRoot();
  const capture = root.capture;
  if (!isObject(capture)) {
    return;
  }
  const projects = capture.projects;
  if (!isObject(projects)) {
    return;
  }
  const forAgent = projects[agent];
  if (!isObject(forAgent)) {
    return;
  }
  delete forAgent[projectKey];
  if (Object.keys(forAgent).length === 0) {
    delete projects[agent];
  }
  await writeConfigRoot(root);
}

async function readCaptureConfig(): Promise<CaptureConfig> {
  return getCaptureConfigFromConfig(await readConfigRoot());
}

function ensureCapture(root: JsonObject): JsonObject {
  const capture = root.capture;
  if (isObject(capture)) {
    return capture;
  }
  root.capture = {};
  return root.capture as JsonObject;
}

function ensureRecord(parent: JsonObject, key: string): JsonObject {
  const value = parent[key];
  if (isObject(value)) {
    return value;
  }
  parent[key] = {};
  return parent[key] as JsonObject;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function defaultConfigRoot(): JsonObject {
  return {
    extractor: {
      name: 'default-extractor',
      llmProvider: 'default',
      embeddingProvider: 'default',
      recallMode: 'hybrid',
      maxAttempts: 3,
      activeWindowDays: 7,
    },
    observer: {
      name: 'default-observer',
      llmProvider: 'default',
      maxAttempts: 3,
      cwdThreshold: 8,
    },
    providers: {
      llm: {
        default: {
          type: 'mock',
        },
      },
      embedding: {
        default: {
          type: 'mock',
          dimensions: 8,
        },
      },
    },
    watchdog: {
      enabled: true,
      intervalMs: 60000,
      compactMinFragments: 8,
      extraction: {
        targetPartitionSize: 1024,
        optimizeMergeCount: 4,
      },
    },
    capture: {
      agents: {
        codex: true,
        'claude-code': true,
      },
      projects: {
        codex: {},
        'claude-code': {},
      },
    },
  };
}
