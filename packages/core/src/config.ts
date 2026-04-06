import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StorageTarget, TableDescription } from './native.js';

const CONFIG_FILE_NAME = 'muninn.json';
const DEFAULT_SUMMARY_THRESHOLD = 500;
const DEFAULT_TITLE_MAX_CHARS = 100;
const DEFAULT_OBSERVER_NAME = 'default-observer';
const DEFAULT_OBSERVER_MAX_ATTEMPTS = 3;
const DEFAULT_EMBEDDING_DIMENSIONS = 8;
const DEFAULT_IMPORTANCE = 0.7;

type LlmConfigRecord = {
  provider: string;
  model?: string;
  api?: string;
  apiKey?: string;
  baseUrl?: string;
};

type TurnConfigRecord = {
  llm?: string;
  llmSummaryThresholdChars?: number;
  titleMaxChars?: number;
};

type ObserverConfigRecord = {
  name: string;
  llm: string;
  maxAttempts?: number;
};

type EmbeddingConfigRecord = {
  provider: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  dimensions?: number;
};

type SemanticIndexConfigRecord = {
  embedding?: EmbeddingConfigRecord;
  defaultImportance?: number;
};

type MuninnConfigRecord = {
  storage?: Record<string, unknown>;
  turn?: TurnConfigRecord;
  observer?: ObserverConfigRecord;
  llm?: Record<string, LlmConfigRecord>;
  semanticIndex?: SemanticIndexConfigRecord;
  watchdog?: Record<string, unknown>;
};

export type TextProviderConfig = {
  provider: 'mock' | 'openai';
  model?: string;
  api?: string;
  apiKey?: string;
  baseUrl?: string;
};

export type TurnLlmConfig = TextProviderConfig & {
  llmSummaryThresholdChars: number;
  titleMaxChars: number;
};

export type ObserverLlmConfig = TextProviderConfig & {
  name: string;
  maxAttempts: number;
};

export type EmbeddingConfig = {
  provider: 'mock' | 'openai';
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  dimensions: number;
  defaultImportance: number;
};

export function resolveMuninnHome(): string {
  return process.env.MUNINN_HOME ?? path.join(os.homedir(), '.muninn');
}

export function resolveMuninnConfigPath(): string {
  return path.join(resolveMuninnHome(), CONFIG_FILE_NAME);
}

export function loadMuninnConfig(): MuninnConfigRecord | null {
  const configPath = resolveMuninnConfigPath();
  if (!fs.existsSync(configPath)) {
    return null;
  }
  return parseMuninnConfigContent(fs.readFileSync(configPath, 'utf8'));
}

export function getTurnLlmConfig(): TurnLlmConfig | null {
  const config = loadMuninnConfig();
  const llmName = config?.turn?.llm;
  const llm = llmName ? config?.llm?.[llmName] : undefined;
  if (!llm) {
    return null;
  }
  return {
    provider: parseProvider(llm.provider),
    model: llm.model,
    api: llm.api,
    apiKey: llm.apiKey,
    baseUrl: llm.baseUrl,
    llmSummaryThresholdChars: config?.turn?.llmSummaryThresholdChars ?? DEFAULT_SUMMARY_THRESHOLD,
    titleMaxChars: config?.turn?.titleMaxChars ?? DEFAULT_TITLE_MAX_CHARS,
  };
}

export function getObserverLlmConfig(): ObserverLlmConfig | null {
  const config = loadMuninnConfig();
  const observer = config?.observer;
  const llm = observer ? config?.llm?.[observer.llm] : undefined;
  if (!observer || !llm) {
    return null;
  }
  return {
    name: observer.name,
    maxAttempts: observer.maxAttempts ?? DEFAULT_OBSERVER_MAX_ATTEMPTS,
    provider: parseProvider(llm.provider),
    model: llm.model,
    api: llm.api,
    apiKey: llm.apiKey,
    baseUrl: llm.baseUrl,
  };
}

export function getEffectiveObserverName(): string {
  return loadMuninnConfig()?.observer?.name ?? DEFAULT_OBSERVER_NAME;
}

export function getEmbeddingConfig(): EmbeddingConfig {
  const semanticIndex = loadMuninnConfig()?.semanticIndex;
  const embedding = semanticIndex?.embedding;
  return {
    provider: parseProvider(embedding?.provider ?? 'mock'),
    model: embedding?.model,
    apiKey: embedding?.apiKey,
    baseUrl: embedding?.baseUrl,
    dimensions: embedding?.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS,
    defaultImportance: semanticIndex?.defaultImportance ?? DEFAULT_IMPORTANCE,
  };
}

export function parseMuninnConfigContent(content: string): MuninnConfigRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('muninn.json must be a JSON object.');
  }
  const config = parsed as MuninnConfigRecord;
  validateTopLevelConfig(config);
  return config;
}

export function validateMuninnConfigInput(content: string): MuninnConfigRecord {
  const config = parseMuninnConfigContent(content);
  validateConfiguredProviders(config);
  return config;
}

export function resolveStorageTarget(config: MuninnConfigRecord): StorageTarget | null {
  const storage = config.storage;
  if (storage?.uri) {
    return {
      uri: storage.uri as string,
      storageOptions: storage.storageOptions as Record<string, string> | undefined,
    };
  }
  return null;
}

export async function validateMuninnConfigStorage(
  config: MuninnConfigRecord,
  description?: TableDescription | null,
): Promise<void> {
  if (!description) {
    return;
  }
  const embedding = config.semanticIndex?.embedding;
  const expectedDimensions = embedding?.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
  const actualDimensions = description.dimensions?.vector ?? 0;
  if (actualDimensions !== expectedDimensions) {
    throw new Error(
      `semantic_index dimension mismatch: muninn.json expects ${expectedDimensions}, but the existing semantic_index table stores ${actualDimensions}; update semanticIndex.embedding.dimensions or rebuild the semantic_index table`,
    );
  }
}

function parseProvider(provider: string): 'mock' | 'openai' {
  if (provider === 'mock' || provider === 'openai') {
    return provider;
  }
  throw new Error(`unsupported llm provider: ${provider}`);
}

function validateTopLevelConfig(config: MuninnConfigRecord): void {
  validateStorageConfig(config.storage);
  validateTurnConfig(config.turn);
  validateObserverConfig(config.observer);
  validateLlmConfig(config.llm);
  validateSemanticIndexConfig(config.semanticIndex);
  validateWatchdogConfig(config.watchdog);
}

function validateConfiguredProviders(config: MuninnConfigRecord): void {
  validateReferencedProvider(config.llm, config.turn?.llm, 'turn.llm');
  validateReferencedProvider(config.llm, config.observer?.llm, 'observer.llm');
  const embeddingProvider = config.semanticIndex?.embedding?.provider;
  if (embeddingProvider) {
    parseProvider(embeddingProvider);
  }
}

function validateStorageConfig(storage: unknown): void {
  if (storage === undefined) {
    return;
  }
  const config = expectRecord(storage, 'storage');
  requireNonEmptyString(config.uri, 'storage.uri');
  validateStringMap(config.storageOptions, 'storage.storageOptions');
}

function validateTurnConfig(turn: unknown): void {
  if (turn === undefined) {
    return;
  }
  const config = expectRecord(turn, 'turn');
  validateOptionalString(config.llm, 'turn.llm');
  validateOptionalPositiveInteger(config.llmSummaryThresholdChars, 'turn.llmSummaryThresholdChars');
  validateOptionalPositiveInteger(config.titleMaxChars, 'turn.titleMaxChars');
}

function validateObserverConfig(observer: unknown): void {
  if (observer === undefined) {
    return;
  }
  const config = expectRecord(observer, 'observer');
  requireNonEmptyString(config.name, 'observer.name');
  requireNonEmptyString(config.llm, 'observer.llm');
  validateOptionalPositiveInteger(config.maxAttempts, 'observer.maxAttempts');
}

function validateLlmConfig(llm: unknown): void {
  if (llm === undefined) {
    return;
  }
  const configs = expectRecord(llm, 'llm');
  for (const [name, section] of Object.entries(configs)) {
    const config = expectRecord(section, `llm.${name}`);
    validateOptionalString(config.provider, `llm.${name}.provider`);
    validateOptionalString(config.model, `llm.${name}.model`);
    validateOptionalString(config.api, `llm.${name}.api`);
    validateOptionalString(config.apiKey, `llm.${name}.apiKey`);
    validateOptionalString(config.baseUrl, `llm.${name}.baseUrl`);
  }
}

function validateSemanticIndexConfig(semanticIndex: unknown): void {
  if (semanticIndex === undefined) {
    return;
  }
  const config = expectRecord(semanticIndex, 'semanticIndex');
  if (config.embedding !== undefined) {
    const embedding = expectRecord(config.embedding, 'semanticIndex.embedding');
    const provider = embedding.provider;
    if (provider !== undefined) {
      requireNonEmptyString(provider, 'semanticIndex.embedding.provider');
      parseProvider(provider as string);
    }
    validateOptionalString(embedding.model, 'semanticIndex.embedding.model');
    validateOptionalString(embedding.apiKey, 'semanticIndex.embedding.apiKey');
    validateOptionalString(embedding.baseUrl, 'semanticIndex.embedding.baseUrl');
    validateOptionalPositiveInteger(embedding.dimensions, 'semanticIndex.embedding.dimensions');
  }
  validateOptionalNumber(config.defaultImportance, 'semanticIndex.defaultImportance');
}

function validateWatchdogConfig(watchdog: unknown): void {
  if (watchdog === undefined) {
    return;
  }
  const config = expectRecord(watchdog, 'watchdog');
  validateOptionalBoolean(config.enabled, 'watchdog.enabled');
  validateOptionalPositiveInteger(config.intervalMs, 'watchdog.intervalMs');
  validateOptionalPositiveInteger(config.compactMinFragments, 'watchdog.compactMinFragments');
  if (config.semanticIndex !== undefined) {
    const semanticIndex = expectRecord(config.semanticIndex, 'watchdog.semanticIndex');
    validateOptionalPositiveInteger(
      semanticIndex.targetPartitionSize,
      'watchdog.semanticIndex.targetPartitionSize',
    );
    validateOptionalPositiveInteger(
      semanticIndex.optimizeMergeCount,
      'watchdog.semanticIndex.optimizeMergeCount',
    );
  }
}

function validateReferencedProvider(
  llmConfigs: Record<string, LlmConfigRecord> | undefined,
  llmName: string | undefined,
  sourceLabel: string,
): void {
  if (!llmName) {
    return;
  }
  const config = llmConfigs?.[llmName];
  if (!config) {
    throw new Error(`${sourceLabel} references missing llm.${llmName}.`);
  }
  requireNonEmptyString(config.provider, `llm.${llmName}.provider`);
  parseProvider(config.provider);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object if provided.`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function validateOptionalString(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new Error(`${label} must be a string.`);
  }
}

function validateOptionalPositiveInteger(value: unknown, label: string): void {
  if (value !== undefined && (!Number.isInteger(value) || (value as number) <= 0)) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function validateOptionalNumber(value: unknown, label: string): void {
  if (value !== undefined && (typeof value !== 'number' || Number.isNaN(value))) {
    throw new Error(`${label} must be a number.`);
  }
}

function validateOptionalBoolean(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean.`);
  }
}

function validateStringMap(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }
  const config = expectRecord(value, label);
  for (const [key, entry] of Object.entries(config)) {
    if (typeof entry !== 'string') {
      throw new Error(`${label}.${key} must be a string.`);
    }
  }
}
