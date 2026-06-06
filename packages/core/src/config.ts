import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StorageTarget, TableDescription } from './native.js';

const CONFIG_FILE_NAME = 'muninn.json';
const DEFAULT_DATABASE = 'main';
const DEFAULT_SUMMARY_THRESHOLD = 500;
const DEFAULT_TITLE_MAX_CHARS = 100;
const DEFAULT_EXTRACTOR_MAX_ATTEMPTS = 3;
const DEFAULT_EXTRACTOR_ACTIVE_WINDOW_DAYS = 7;
const DEFAULT_EXTRACTOR_CONTINUITY_HINTS = 1;
const DEFAULT_EXTRACTOR_EPOCH_TURNS = 3;
const DEFAULT_EXTRACTOR_EPOCH_WINDOW_MS = 10_000;
const DEFAULT_OBSERVER_MAX_ATTEMPTS = 3;
const DEFAULT_WATCHDOG_INTERVAL_MS = 60_000;
const DEFAULT_WATCHDOG_COMPACT_MIN_FRAGMENTS = 8;
const DEFAULT_WATCHDOG_TARGET_PARTITION_SIZE = 1_024;
const DEFAULT_WATCHDOG_OPTIMIZE_MERGE_COUNT = 4;
const DEFAULT_EXTRACTION_DIMENSIONS = 8;
const DEFAULT_RECALL_MODE = 'hybrid';
const DEFAULT_OBSERVER_CWD_THRESHOLD = 8;
const DEFAULT_OBSERVER_CWD_BATCH_SIZE = 16;
const DEFAULT_OBSERVER_CONTENT_BUDGET_CHARS = 24_000;

export type RecallMode = 'vector' | 'fts' | 'hybrid';

type LlmConfigRecord = {
  type: string;
  model?: string;
  api?: string;
  apiKey?: string;
  baseUrl?: string;
};

type TurnConfigRecord = {
  llmProvider?: string;
  llmSummaryThresholdChars?: number;
  titleMaxChars?: number;
};

type ExtractorConfigRecord = {
  name: string;
  llmProvider: string;
  embeddingProvider: string;
  recallMode?: RecallMode;
  maxAttempts?: number;
  activeWindowDays?: number;
  continuityHints?: number;
  epochTurns?: number;
  epochWindowMs?: number;
  domainPrompt?: string;
};

type ObserverConfigRecord = {
  enabled?: boolean;
  name?: string;
  llmProvider?: string;
  maxAttempts?: number;
  cwdThreshold?: number;
  cwdBatchSize?: number;
  contentBudgetChars?: number;
};

type EmbeddingConfigRecord = {
  type: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  dimensions?: number;
};

type ProvidersConfigRecord = {
  llm?: Record<string, LlmConfigRecord>;
  embedding?: Record<string, EmbeddingConfigRecord>;
};

type MuninnConfigRecord = {
  storage?: Record<string, unknown>;
  turn?: TurnConfigRecord;
  extractor?: ExtractorConfigRecord;
  observer?: ObserverConfigRecord;
  providers?: ProvidersConfigRecord;
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

export type ExtractorLlmConfig = TextProviderConfig & {
  name: string;
  maxAttempts: number;
  activeWindowDays: number;
  continuityHints: number;
  epochTurns: number;
  epochWindowMs: number;
  domainPrompt?: string;
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
};

export type RecallConfig = {
  mode: RecallMode;
};

export type ObserverRuntimeConfig = {
  cwdThreshold: number;
  cwdBatchSize: number;
  contentBudgetChars: number;
};

export type WatchdogConfig = {
  enabled: boolean;
  intervalMs: number;
  compactMinFragments: number;
  extraction: {
    targetPartitionSize: number;
    optimizeMergeCount: number;
  };
};

type CoreRuntimeConfig = {
  extractor: ExtractorConfigRecord;
  extractorLlm: LlmConfigRecord;
  observer?: ObserverConfigRecord;
  observerLlm?: LlmConfigRecord;
  observerEnabled: boolean;
  embedding: EmbeddingConfigRecord & { dimensions: number };
};

export function resolveMuninnHome(): string {
  return process.env.MUNINN_HOME ?? path.join(os.homedir(), '.muninn');
}

export function resolveMuninnConfigPath(): string {
  return path.join(resolveMuninnHome(), CONFIG_FILE_NAME);
}

export function resolveDatabaseName(database?: string | null): string {
  const value = database?.trim() || DEFAULT_DATABASE;
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') {
    throw new Error('database must be a safe path segment using letters, numbers, ".", "_", or "-"');
  }
  return value;
}

export function resolveDatabaseHome(database?: string | null): string {
  return path.join(resolveMuninnHome(), resolveDatabaseName(database));
}

export function resolveDatabaseLogPath(
  database: string | null | undefined,
  fileName: string,
): string {
  return path.join(resolveDatabaseHome(database), 'logs', fileName);
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
  const llmName = config?.turn?.llmProvider;
  const llm = llmName ? config?.providers?.llm?.[llmName] : undefined;
  if (!llm) {
    return null;
  }
  return {
    provider: parseLlmProvider(llm.type),
    model: llm.model,
    api: llm.api,
    apiKey: llm.apiKey,
    baseUrl: llm.baseUrl,
    llmSummaryThresholdChars: config?.turn?.llmSummaryThresholdChars ?? DEFAULT_SUMMARY_THRESHOLD,
    titleMaxChars: config?.turn?.titleMaxChars ?? DEFAULT_TITLE_MAX_CHARS,
  };
}

export function getExtractorLlmConfig(): ExtractorLlmConfig | null {
  const { extractor, extractorLlm: llm } = requireCoreRuntimeConfig(loadMuninnConfig());
  return {
    name: extractor.name,
    maxAttempts: extractor.maxAttempts ?? DEFAULT_EXTRACTOR_MAX_ATTEMPTS,
    activeWindowDays: extractor.activeWindowDays ?? DEFAULT_EXTRACTOR_ACTIVE_WINDOW_DAYS,
    continuityHints: extractor.continuityHints ?? DEFAULT_EXTRACTOR_CONTINUITY_HINTS,
    epochTurns: extractor.epochTurns ?? DEFAULT_EXTRACTOR_EPOCH_TURNS,
    epochWindowMs: extractor.epochWindowMs ?? DEFAULT_EXTRACTOR_EPOCH_WINDOW_MS,
    domainPrompt: extractor.domainPrompt,
    provider: parseLlmProvider(llm.type),
    model: llm.model,
    api: llm.api,
    apiKey: llm.apiKey,
    baseUrl: llm.baseUrl,
  };
}

export function getObserverLlmConfig(): ObserverLlmConfig | null {
  const { observer, observerLlm: llm, observerEnabled } = requireCoreRuntimeConfig(loadMuninnConfig());
  if (!observerEnabled || !observer || !llm) {
    return null;
  }
  return {
    name: observer.name!,
    maxAttempts: observer.maxAttempts ?? DEFAULT_OBSERVER_MAX_ATTEMPTS,
    provider: parseLlmProvider(llm.type),
    model: llm.model,
    api: llm.api,
    apiKey: llm.apiKey,
    baseUrl: llm.baseUrl,
  };
}

export function getEffectiveExtractorName(): string {
  return requireCoreRuntimeConfig(loadMuninnConfig()).extractor.name;
}

export function getEmbeddingConfig(): EmbeddingConfig {
  const { embedding } = requireCoreRuntimeConfig(loadMuninnConfig());
  return {
    provider: parseEmbeddingProvider(embedding.type),
    model: embedding.model,
    apiKey: embedding.apiKey,
    baseUrl: embedding.baseUrl,
    dimensions: embedding.dimensions,
  };
}

export function getRecallConfig(): RecallConfig {
  return {
    mode: parseRecallMode(loadMuninnConfig()?.extractor?.recallMode ?? DEFAULT_RECALL_MODE),
  };
}

export function isObserverEnabled(): boolean {
  return isObserverEnabledFromConfig(loadMuninnConfig());
}

export function getObserverRuntimeConfig(): ObserverRuntimeConfig {
  return getObserverRuntimeConfigFromConfig(loadMuninnConfig());
}

export function getObserverRuntimeConfigFromConfigForTests(config: MuninnConfigRecord | null): ObserverRuntimeConfig {
  return getObserverRuntimeConfigFromConfig(config);
}

function getObserverRuntimeConfigFromConfig(config: MuninnConfigRecord | null): ObserverRuntimeConfig {
  return {
    cwdThreshold: config?.observer?.cwdThreshold ?? DEFAULT_OBSERVER_CWD_THRESHOLD,
    cwdBatchSize: config?.observer?.cwdBatchSize ?? DEFAULT_OBSERVER_CWD_BATCH_SIZE,
    contentBudgetChars: config?.observer?.contentBudgetChars ?? DEFAULT_OBSERVER_CONTENT_BUDGET_CHARS,
  };
}

export function getWatchdogConfig(): WatchdogConfig {
  const watchdog = loadMuninnConfig()?.watchdog as Record<string, unknown> | undefined;
  const extraction = watchdog?.extraction as Record<string, unknown> | undefined;
  return {
    enabled: typeof watchdog?.enabled === 'boolean' ? watchdog.enabled : true,
    intervalMs: typeof watchdog?.intervalMs === 'number'
      ? watchdog.intervalMs
      : DEFAULT_WATCHDOG_INTERVAL_MS,
    compactMinFragments: typeof watchdog?.compactMinFragments === 'number'
      ? watchdog.compactMinFragments
      : DEFAULT_WATCHDOG_COMPACT_MIN_FRAGMENTS,
    extraction: {
      targetPartitionSize: typeof extraction?.targetPartitionSize === 'number'
        ? extraction.targetPartitionSize
        : DEFAULT_WATCHDOG_TARGET_PARTITION_SIZE,
      optimizeMergeCount: typeof extraction?.optimizeMergeCount === 'number'
        ? extraction.optimizeMergeCount
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
  if ((config.turn || config.extractor || config.observer) && !config.providers) {
    throw new Error('providers is required.');
  }
  validateConfiguredProviders(config);
  requireCoreRuntimeConfig(config);
  return config;
}

export function resolveStorageTarget(
  config: MuninnConfigRecord,
  database?: string | null,
): StorageTarget {
  const databaseName = resolveDatabaseName(database);
  const storage = config.storage;
  if (storage?.uri) {
    return {
      uri: appendDatabaseToStorageUri(storage.uri as string, databaseName),
      storageOptions: storage.storageOptions as Record<string, string> | undefined,
    };
  }
  return {
    uri: localStorageUri(resolveDatabaseHome(databaseName)),
  };
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
      `extraction dimension mismatch: muninn.json expects ${expectedDimensions}, but the existing extraction table stores ${actualDimensions}; update providers.embedding.${config.extractor?.embeddingProvider}.dimensions or rebuild the extraction table`,
    );
  }
}

function requireCoreRuntimeConfig(config: MuninnConfigRecord | null): CoreRuntimeConfig {
  if (!config?.extractor) {
    throw new Error('extractor is required.');
  }
  const observerEnabled = isObserverEnabledFromConfig(config);
  if (observerEnabled && !config.observer) {
    throw new Error('observer is required.');
  }
  if (!config.providers) {
    throw new Error('providers is required.');
  }
  if (!config.providers.llm) {
    throw new Error('providers.llm is required.');
  }
  if (!config.providers.embedding) {
    throw new Error('providers.embedding is required.');
  }

  const extractor = config.extractor;
  const observer = config.observer;
  const llm = config.providers.llm;
  const embeddings = config.providers.embedding;

  requireNonEmptyString(extractor.name, 'extractor.name');
  requireNonEmptyString(extractor.llmProvider, 'extractor.llmProvider');
  requireNonEmptyString(extractor.embeddingProvider, 'extractor.embeddingProvider');
  if (observerEnabled) {
    requireNonEmptyString(observer?.name, 'observer.name');
    requireNonEmptyString(observer?.llmProvider, 'observer.llmProvider');
  }
  const embeddingProvider = extractor.embeddingProvider;
  const dimensions = effectiveEmbeddingDimensions(config);

  const extractorLlm = llm[extractor.llmProvider];
  if (!extractorLlm) {
    throw new Error(`extractor.llmProvider references missing providers.llm.${extractor.llmProvider}.`);
  }
  requireNonEmptyString(extractorLlm.type, `providers.llm.${extractor.llmProvider}.type`);
  parseLlmProvider(extractorLlm.type);

  const observerLlm = observerEnabled ? llm[observer!.llmProvider!] : undefined;
  if (observerEnabled) {
    if (!observerLlm) {
      throw new Error(`observer.llmProvider references missing providers.llm.${observer!.llmProvider}.`);
    }
    requireNonEmptyString(observerLlm.type, `providers.llm.${observer!.llmProvider}.type`);
    parseLlmProvider(observerLlm.type);
  }

  const embedding = embeddings[embeddingProvider];
  if (!embedding) {
    throw new Error(`extractor.embeddingProvider references missing providers.embedding.${embeddingProvider}.`);
  }
  requireNonEmptyString(embedding.type, `providers.embedding.${embeddingProvider}.type`);
  parseEmbeddingProvider(embedding.type);

  return {
    extractor,
    extractorLlm,
    observer,
    observerLlm,
    observerEnabled,
    embedding: {
      ...embedding,
      dimensions,
    },
  };
}

function isObserverEnabledFromConfig(config: MuninnConfigRecord | null): boolean {
  return config?.observer?.enabled !== false;
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
    throw new Error('semanticIndex is no longer supported; use extractor.embeddingProvider instead.');
  }
  if (raw.llm !== undefined) {
    throw new Error('llm is no longer supported; use providers.llm instead.');
  }
  if (raw.extraction !== undefined) {
    throw new Error('extraction is no longer supported; use extractor.embeddingProvider and extractor.recallMode instead.');
  }
  validateStorageConfig(config.storage);
  validateTurnConfig(config.turn);
  validateExtractorConfig(config.extractor);
  validateObserverConfig(config.observer);
  validateProvidersConfig(config.providers);
  validateWatchdogConfig(config.watchdog);
}

function validateConfiguredProviders(config: MuninnConfigRecord): void {
  validateReferencedLlmProvider(config.providers?.llm, config.turn?.llmProvider, 'turn.llmProvider');
  validateReferencedLlmProvider(config.providers?.llm, config.extractor?.llmProvider, 'extractor.llmProvider');
  if (isObserverEnabledFromConfig(config)) {
    validateReferencedLlmProvider(config.providers?.llm, config.observer?.llmProvider, 'observer.llmProvider');
  }
  validateReferencedEmbeddingProvider(
    config.providers?.embedding,
    config.extractor?.embeddingProvider,
    'extractor.embeddingProvider',
  );
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
  if (config.llm !== undefined) {
    throw new Error('turn.llm is no longer supported; use turn.llmProvider instead.');
  }
  validateOptionalString(config.llmProvider, 'turn.llmProvider');
  validateOptionalPositiveInteger(config.llmSummaryThresholdChars, 'turn.llmSummaryThresholdChars');
  validateOptionalPositiveInteger(config.titleMaxChars, 'turn.titleMaxChars');
}

function validateExtractorConfig(extractor: unknown): void {
  if (extractor === undefined) {
    return;
  }
  const config = expectRecord(extractor, 'extractor');
  if (config.llm !== undefined) {
    throw new Error('extractor.llm is no longer supported; use extractor.llmProvider instead.');
  }
  if (config.defaultImportance !== undefined) {
    throw new Error('extractor.defaultImportance is not supported; extraction importance has been removed.');
  }
  requireNonEmptyString(config.name, 'extractor.name');
  requireNonEmptyString(config.llmProvider, 'extractor.llmProvider');
  requireNonEmptyString(config.embeddingProvider, 'extractor.embeddingProvider');
  if (config.recallMode !== undefined) {
    parseRecallMode(config.recallMode);
  }
  validateOptionalPositiveInteger(config.maxAttempts, 'extractor.maxAttempts');
  validateOptionalPositiveInteger(config.activeWindowDays, 'extractor.activeWindowDays');
  validateOptionalPositiveInteger(config.continuityHints, 'extractor.continuityHints');
  validateOptionalPositiveInteger(config.epochTurns, 'extractor.epochTurns');
  validateOptionalPositiveInteger(config.epochWindowMs, 'extractor.epochWindowMs');
  validateOptionalDomainPrompt(config.domainPrompt);
}

function validateObserverConfig(observer: unknown): void {
  if (observer === undefined) {
    return;
  }
  const config = expectRecord(observer, 'observer');
  if (config.llm !== undefined) {
    throw new Error('observer.llm is no longer supported; use observer.llmProvider instead.');
  }
  validateOptionalBoolean(config.enabled, 'observer.enabled');
  if (config.enabled === false) {
    validateOptionalString(config.name, 'observer.name');
    validateOptionalString(config.llmProvider, 'observer.llmProvider');
    return;
  }
  requireNonEmptyString(config.name, 'observer.name');
  requireNonEmptyString(config.llmProvider, 'observer.llmProvider');
  validateOptionalPositiveInteger(config.maxAttempts, 'observer.maxAttempts');
  validateOptionalPositiveInteger(config.cwdThreshold, 'observer.cwdThreshold');
  validateOptionalPositiveInteger(config.cwdBatchSize, 'observer.cwdBatchSize');
  validateOptionalPositiveInteger(config.contentBudgetChars, 'observer.contentBudgetChars');
}

function validateProvidersConfig(providers: unknown): void {
  if (providers === undefined) {
    return;
  }
  const config = expectRecord(providers, 'providers');
  if (config.llm !== undefined) {
    const llm = expectRecord(config.llm, 'providers.llm');
    for (const [name, section] of Object.entries(llm)) {
      const provider = expectRecord(section, `providers.llm.${name}`);
      requireNonEmptyString(provider.type, `providers.llm.${name}.type`);
      const providerType = provider.type as string;
      validateOptionalString(provider.model, `providers.llm.${name}.model`);
      validateOptionalString(provider.api, `providers.llm.${name}.api`);
      validateOptionalString(provider.apiKey, `providers.llm.${name}.apiKey`);
      validateOptionalString(provider.baseUrl, `providers.llm.${name}.baseUrl`);
      if (parseLlmProvider(providerType) === 'openai') {
        requireNonEmptyString(provider.apiKey, `providers.llm.${name}.apiKey`);
      }
    }
  }
  if (config.embedding !== undefined) {
    const embedding = expectRecord(config.embedding, 'providers.embedding');
    for (const [name, section] of Object.entries(embedding)) {
      const provider = expectRecord(section, `providers.embedding.${name}`);
      requireNonEmptyString(provider.type, `providers.embedding.${name}.type`);
      const providerType = provider.type as string;
      validateOptionalString(provider.model, `providers.embedding.${name}.model`);
      validateOptionalString(provider.apiKey, `providers.embedding.${name}.apiKey`);
      validateOptionalString(provider.baseUrl, `providers.embedding.${name}.baseUrl`);
      validateOptionalPositiveInteger(provider.dimensions, `providers.embedding.${name}.dimensions`);
      if (parseEmbeddingProvider(providerType) === 'openai') {
        requireNonEmptyString(provider.apiKey, `providers.embedding.${name}.apiKey`);
      }
    }
  }
}

export function parseRecallMode(value: unknown): RecallMode {
  if (value === 'vector' || value === 'fts' || value === 'hybrid') {
    return value;
  }
  throw new Error('extractor.recallMode must be one of: vector, fts, hybrid');
}

function appendDatabaseToStorageUri(uri: string, database: string): string {
  return `${uri.replace(/\/+$/, '')}/${database}`;
}

function localStorageUri(directory: string): string {
  return `file-object-store://${path.resolve(directory)}`;
}

function effectiveEmbeddingDimensions(config: MuninnConfigRecord | null): number {
  const embeddingName = config?.extractor?.embeddingProvider;
  const dimensions = embeddingName ? config?.providers?.embedding?.[embeddingName]?.dimensions : undefined;
  if (dimensions === undefined) {
    return DEFAULT_EXTRACTION_DIMENSIONS;
  }
  return requirePositiveInteger(dimensions, `providers.embedding.${embeddingName}.dimensions`);
}

function validateWatchdogConfig(watchdog: unknown): void {
  if (watchdog === undefined) {
    return;
  }
  const config = expectRecord(watchdog, 'watchdog');
  validateOptionalBoolean(config.enabled, 'watchdog.enabled');
  validateOptionalPositiveInteger(config.intervalMs, 'watchdog.intervalMs');
  validateOptionalPositiveInteger(config.compactMinFragments, 'watchdog.compactMinFragments');
  if (config.extraction !== undefined) {
    const extraction = expectRecord(config.extraction, 'watchdog.extraction');
    validateOptionalPositiveInteger(
      extraction.targetPartitionSize,
      'watchdog.extraction.targetPartitionSize',
    );
    validateOptionalPositiveInteger(
      extraction.optimizeMergeCount,
      'watchdog.extraction.optimizeMergeCount',
    );
  }
}

function validateReferencedLlmProvider(
  llmConfigs: Record<string, LlmConfigRecord> | undefined,
  providerName: string | undefined,
  sourceLabel: string,
): void {
  if (!providerName) {
    return;
  }
  const config = llmConfigs?.[providerName];
  if (!config) {
    throw new Error(`${sourceLabel} references missing providers.llm.${providerName}.`);
  }
  requireNonEmptyString(config.type, `providers.llm.${providerName}.type`);
  const provider = parseLlmProvider(config.type);
  if (provider === 'openai') {
    requireNonEmptyString(config.apiKey, `providers.llm.${providerName}.apiKey`);
  }
}

function validateReferencedEmbeddingProvider(
  embeddingConfigs: Record<string, EmbeddingConfigRecord> | undefined,
  providerName: string | undefined,
  sourceLabel: string,
): void {
  if (!providerName) {
    return;
  }
  const config = embeddingConfigs?.[providerName];
  if (!config) {
    throw new Error(`${sourceLabel} references missing providers.embedding.${providerName}.`);
  }
  requireNonEmptyString(config.type, `providers.embedding.${providerName}.type`);
  const provider = parseEmbeddingProvider(config.type);
  if (provider === 'openai') {
    requireNonEmptyString(config.apiKey, `providers.embedding.${providerName}.apiKey`);
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
    throw new Error('extractor.domainPrompt must be one of: chat');
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
