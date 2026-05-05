import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StorageTarget, TableDescription } from './native.js';

const CONFIG_FILE_NAME = 'muninn.json';
const DEFAULT_SUMMARY_THRESHOLD = 500;
const DEFAULT_TITLE_MAX_CHARS = 100;
const DEFAULT_OBSERVER_MAX_ATTEMPTS = 3;
const DEFAULT_OBSERVER_ACTIVE_WINDOW_DAYS = 7;
const DEFAULT_OBSERVER_CONTINUITY_HINTS = 1;
const DEFAULT_OBSERVER_EPOCH_TURNS = 3;
const DEFAULT_OBSERVER_EPOCH_WINDOW_MS = 10_000;
const DEFAULT_IMPORTANCE = 0.7;
const DEFAULT_WATCHDOG_INTERVAL_MS = 60_000;
const DEFAULT_WATCHDOG_COMPACT_MIN_FRAGMENTS = 8;
const DEFAULT_WATCHDOG_TARGET_PARTITION_SIZE = 1_024;
const DEFAULT_WATCHDOG_OPTIMIZE_MERGE_COUNT = 4;
const DEFAULT_OBSERVATION_DIMENSIONS = 8;

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
  activeWindowDays?: number;
  continuityHints?: number;
  epochTurns?: number;
  epochWindowMs?: number;
  domainPrompt?: string;
};

type EmbeddingConfigRecord = {
  provider: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  dimensions?: number;
};

type ObservationConfigRecord = {
  embedding?: EmbeddingConfigRecord;
  defaultImportance?: number;
};

type MuninnConfigRecord = {
  storage?: Record<string, unknown>;
  turn?: TurnConfigRecord;
  observer?: ObserverConfigRecord;
  llm?: Record<string, LlmConfigRecord>;
  observation?: ObservationConfigRecord;
  watchdog?: Record<string, unknown>;
};

export type TextProviderConfig = {
  provider: 'mock' | 'openai' | 'openai-codex';
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
  activeWindowDays: number;
  continuityHints: number;
  epochTurns: number;
  epochWindowMs: number;
  domainPrompt?: string;
};

export type EmbeddingConfig = {
  provider: 'mock' | 'openai';
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  dimensions: number;
  defaultImportance: number;
};

export type WatchdogConfig = {
  enabled: boolean;
  intervalMs: number;
  compactMinFragments: number;
  observation: {
    targetPartitionSize: number;
    optimizeMergeCount: number;
  };
};

type CoreRuntimeConfig = {
  observer: ObserverConfigRecord;
  observerLlm: LlmConfigRecord;
  observation: ObservationConfigRecord;
  embedding: EmbeddingConfigRecord & { dimensions: number };
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
    provider: parseLlmProvider(llm.provider),
    model: llm.model,
    api: llm.api,
    apiKey: llm.apiKey,
    baseUrl: llm.baseUrl,
    llmSummaryThresholdChars: config?.turn?.llmSummaryThresholdChars ?? DEFAULT_SUMMARY_THRESHOLD,
    titleMaxChars: config?.turn?.titleMaxChars ?? DEFAULT_TITLE_MAX_CHARS,
  };
}

export function getObserverLlmConfig(): ObserverLlmConfig | null {
  const { observer, observerLlm: llm } = requireCoreRuntimeConfig(loadMuninnConfig());
  return {
    name: observer.name,
    maxAttempts: observer.maxAttempts ?? DEFAULT_OBSERVER_MAX_ATTEMPTS,
    activeWindowDays: observer.activeWindowDays ?? DEFAULT_OBSERVER_ACTIVE_WINDOW_DAYS,
    continuityHints: observer.continuityHints ?? DEFAULT_OBSERVER_CONTINUITY_HINTS,
    epochTurns: observer.epochTurns ?? DEFAULT_OBSERVER_EPOCH_TURNS,
    epochWindowMs: observer.epochWindowMs ?? DEFAULT_OBSERVER_EPOCH_WINDOW_MS,
    domainPrompt: observer.domainPrompt,
    provider: parseLlmProvider(llm.provider),
    model: llm.model,
    api: llm.api,
    apiKey: llm.apiKey,
    baseUrl: llm.baseUrl,
  };
}

export function getEffectiveObserverName(): string {
  return requireCoreRuntimeConfig(loadMuninnConfig()).observer.name;
}

export function getEmbeddingConfig(): EmbeddingConfig {
  const { observation, embedding } = requireCoreRuntimeConfig(loadMuninnConfig());
  return {
    provider: parseEmbeddingProvider(embedding.provider),
    model: embedding.model,
    apiKey: embedding.apiKey,
    baseUrl: embedding.baseUrl,
    dimensions: embedding.dimensions,
    defaultImportance: observation.defaultImportance ?? DEFAULT_IMPORTANCE,
  };
}

export function getWatchdogConfig(): WatchdogConfig {
  const watchdog = loadMuninnConfig()?.watchdog as Record<string, unknown> | undefined;
  const observation = watchdog?.observation as Record<string, unknown> | undefined;
  return {
    enabled: typeof watchdog?.enabled === 'boolean' ? watchdog.enabled : true,
    intervalMs: typeof watchdog?.intervalMs === 'number'
      ? watchdog.intervalMs
      : DEFAULT_WATCHDOG_INTERVAL_MS,
    compactMinFragments: typeof watchdog?.compactMinFragments === 'number'
      ? watchdog.compactMinFragments
      : DEFAULT_WATCHDOG_COMPACT_MIN_FRAGMENTS,
    observation: {
      targetPartitionSize: typeof observation?.targetPartitionSize === 'number'
        ? observation.targetPartitionSize
        : DEFAULT_WATCHDOG_TARGET_PARTITION_SIZE,
      optimizeMergeCount: typeof observation?.optimizeMergeCount === 'number'
        ? observation.optimizeMergeCount
        : DEFAULT_WATCHDOG_OPTIMIZE_MERGE_COUNT,
    },
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
  if (config.observer && !config.llm) {
    throw new Error('llm is required.');
  }
  validateConfiguredProviders(config);
  requireCoreRuntimeConfig(config);
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
  const expectedDimensions = effectiveEmbeddingDimensions(config);
  const actualDimensions = description.dimensions?.vector;
  if (actualDimensions === undefined) {
    return;
  }
  if (actualDimensions !== expectedDimensions) {
    throw new Error(
      `observation dimension mismatch: muninn.json expects ${expectedDimensions}, but the existing observation table stores ${actualDimensions}; update observation.embedding.dimensions or rebuild the observation table`,
    );
  }
}

function requireCoreRuntimeConfig(config: MuninnConfigRecord | null): CoreRuntimeConfig {
  if (!config?.observer) {
    throw new Error('observer is required.');
  }
  if (!config.llm) {
    throw new Error('llm is required.');
  }
  if (!config.observation) {
    throw new Error('observation is required.');
  }
  if (!config.observation.embedding) {
    throw new Error('observation.embedding is required.');
  }

  const observer = config.observer;
  const llm = config.llm;
  const observation = config.observation;
  const embedding = config.observation.embedding;

  requireNonEmptyString(observer.name, 'observer.name');
  requireNonEmptyString(observer.llm, 'observer.llm');
  requireNonEmptyString(embedding.provider, 'observation.embedding.provider');
  const dimensions = effectiveEmbeddingDimensions(config);
  parseEmbeddingProvider(embedding.provider);

  const observerLlm = llm[observer.llm];
  if (!observerLlm) {
    throw new Error(`observer.llm references missing llm.${observer.llm}.`);
  }
  requireNonEmptyString(observerLlm.provider, `llm.${observer.llm}.provider`);
  parseLlmProvider(observerLlm.provider);

  return {
    observer,
    observerLlm,
    observation,
    embedding: {
      ...embedding,
      dimensions,
    },
  };
}

function parseLlmProvider(provider: string): 'mock' | 'openai' | 'openai-codex' {
  if (provider === 'mock' || provider === 'openai' || provider === 'openai-codex') {
    return provider;
  }
  throw new Error(`unsupported llm provider: ${provider}`);
}

function parseEmbeddingProvider(provider: string): 'mock' | 'openai' {
  if (provider === 'mock' || provider === 'openai') {
    return provider;
  }
  throw new Error(`unsupported embedding provider: ${provider}`);
}

function validateTopLevelConfig(config: MuninnConfigRecord): void {
  const raw = config as Record<string, unknown>;
  if (raw.semanticIndex !== undefined) {
    throw new Error('semanticIndex is no longer supported; use observation instead.');
  }
  validateStorageConfig(config.storage);
  validateTurnConfig(config.turn);
  validateObserverConfig(config.observer);
  validateLlmConfig(config.llm);
  validateObservationConfig(config.observation);
  validateWatchdogConfig(config.watchdog);
}

function validateConfiguredProviders(config: MuninnConfigRecord): void {
  validateReferencedProvider(config.llm, config.turn?.llm, 'turn.llm');
  validateReferencedProvider(config.llm, config.observer?.llm, 'observer.llm');
  const embeddingProvider = config.observation?.embedding?.provider;
  if (embeddingProvider) {
    parseEmbeddingProvider(embeddingProvider);
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
  validateOptionalPositiveInteger(config.activeWindowDays, 'observer.activeWindowDays');
  validateOptionalPositiveInteger(config.continuityHints, 'observer.continuityHints');
  validateOptionalPositiveInteger(config.epochTurns, 'observer.epochTurns');
  validateOptionalPositiveInteger(config.epochWindowMs, 'observer.epochWindowMs');
  validateOptionalDomainPrompt(config.domainPrompt);
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

function validateObservationConfig(observation: unknown): void {
  if (observation === undefined) {
    return;
  }
  const config = expectRecord(observation, 'observation');
  if (config.embedding === undefined) {
    throw new Error('observation.embedding is required.');
  }
  const embedding = expectRecord(config.embedding, 'observation.embedding');
  requireNonEmptyString(embedding.provider, 'observation.embedding.provider');
  const provider = parseEmbeddingProvider(embedding.provider as string);
  validateOptionalString(embedding.model, 'observation.embedding.model');
  validateOptionalString(embedding.apiKey, 'observation.embedding.apiKey');
  validateOptionalString(embedding.baseUrl, 'observation.embedding.baseUrl');
  validateOptionalPositiveInteger(embedding.dimensions, 'observation.embedding.dimensions');
  validateOptionalNumber(config.defaultImportance, 'observation.defaultImportance');
  if (provider === 'openai') {
    requireNonEmptyString(embedding.apiKey, 'observation.embedding.apiKey');
  }
}

function effectiveEmbeddingDimensions(config: MuninnConfigRecord | null): number {
  const dimensions = config?.observation?.embedding?.dimensions;
  if (dimensions === undefined) {
    return DEFAULT_OBSERVATION_DIMENSIONS;
  }
  return requirePositiveInteger(dimensions, 'observation.embedding.dimensions');
}

function validateWatchdogConfig(watchdog: unknown): void {
  if (watchdog === undefined) {
    return;
  }
  const config = expectRecord(watchdog, 'watchdog');
  validateOptionalBoolean(config.enabled, 'watchdog.enabled');
  validateOptionalPositiveInteger(config.intervalMs, 'watchdog.intervalMs');
  validateOptionalPositiveInteger(config.compactMinFragments, 'watchdog.compactMinFragments');
  if (config.observation !== undefined) {
    const observation = expectRecord(config.observation, 'watchdog.observation');
    validateOptionalPositiveInteger(
      observation.targetPartitionSize,
      'watchdog.observation.targetPartitionSize',
    );
    validateOptionalPositiveInteger(
      observation.optimizeMergeCount,
      'watchdog.observation.optimizeMergeCount',
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
  const provider = parseLlmProvider(config.provider);
  if (provider === 'openai') {
    requireNonEmptyString(config.apiKey, `llm.${llmName}.apiKey`);
  }
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

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value as number;
}

function validateOptionalString(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new Error(`${label} must be a string.`);
  }
}

function validateOptionalDomainPrompt(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (value !== 'chat') {
    throw new Error('observer.domainPrompt must be one of: chat');
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
