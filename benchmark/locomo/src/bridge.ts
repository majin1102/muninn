#!/usr/bin/env node

import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { RenderedMemory, SessionTurn, TurnContent } from '@muninn/core';
import * as coreClient from '@muninn/core';

const CONFIG_FILE_NAME = 'muninn.json';
const WATERMARK_POLL_MS = 2_000;
const WATERMARK_TIMEOUT_MS = 10 * 60 * 1_000;
const WATERMARK_WARNING_DELAY_MS = 60_000;
const RECALL_ATTEMPTS = 3;
const RECALL_RETRY_DELAY_MS = 1_000;
const REPO_ROOT = path.resolve(__dirname, '../../..');
const SIDECAR_APP_PATH = path.join(REPO_ROOT, 'packages/sidecar/dist/app.js');
const IMPORT_PLACEHOLDER_RESPONSE = '[imported dialogue event; no assistant response]';

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

type LocomoDialog = {
  speaker: string;
  dia_id: string;
  text?: string;
  clean_text?: string;
  compressed_text?: string;
  blip_caption?: string;
};

type LocomoSample = {
  sample_id: string;
  conversation: Record<string, string | LocomoDialog[]>;
};

export type ManifestTurn = {
  turn_id: string;
  source_id: string;
  sample_id: string;
  session_id: string;
  date_time: string;
  import_order: number;
};

export type ImportManifest = {
  sample_id: string;
  baseline_observing_epoch?: number;
  baseline_committed_epoch?: number;
  turns: ManifestTurn[];
};

type BridgeHit = {
  memory_id: string;
  matched_text: string;
  evidence_ids: string[];
  date_time?: string;
  title?: string;
  summary?: string;
  detail?: string;
  observationRatio?: number | null;
  references: BridgeReference[];
};

type BridgeReference = {
  memory_id: string;
  source_id: string;
  date_time: string;
  text: string;
};

type RecallBatchQuery = {
  key: string;
  query: string;
  limit: number;
};

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);

  try {
    switch (command) {
      case 'reset-home':
        await resetHome(requireOption(options, 'muninn-home'));
        emitJson({ ok: true });
        break;
      case 'import-sample':
        emitJson(await importSampleCommand(options));
        break;
      case 'recall':
        emitJson(await recallCommand(options));
        break;
      case 'recall-batch':
        emitJson(await recallBatchCommand(options));
        break;
      default:
        throw new Error(`unknown command: ${command ?? '<missing>'}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await coreClient.shutdownCoreForTests();
  }
}

async function resetHome(home: string) {
  await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true });
}

async function importSampleCommand(options: Map<string, string>) {
  const dataFile = requireOption(options, 'data-file');
  const sampleId = requireOption(options, 'sample-id');
  const home = requireOption(options, 'muninn-home');
  const sourceConfigPath = resolveActiveConfigPath();
  const templateConfigPath = await resolveBenchmarkConfigPath();
  await mkdir(home, { recursive: true });
  await bootstrapHome(home, templateConfigPath, sourceConfigPath);
  process.env.MUNINN_HOME = home;
  const gatewayTracePath = setGatewayTraceFile(home);
  const baselineWatermark = await fetchObserverWatermark();

  const sample = await loadSample(dataFile, sampleId);
  const manifestTurns: ManifestTurn[] = [];
  let importOrder = 0;

  for (const sessionNo of getSessionNumbers(sample.conversation)) {
    const dateTime = getDateTime(sample.conversation, sessionNo);
    const dialogs = sample.conversation[`session_${sessionNo}`] as LocomoDialog[];
    const sessionId = sessionKey(sample.sample_id, sessionNo);
    for (const dialog of dialogs) {
      const text = dialogLine(dialog, dateTime);
      const turn = await addTurnAndFind({
        sessionId,
        agent: dialog.speaker,
        prompt: text,
        response: IMPORT_PLACEHOLDER_RESPONSE,
      });
      manifestTurns.push({
        turn_id: turn.turnId,
        source_id: dialog.dia_id,
        sample_id: sample.sample_id,
        session_id: sessionId,
        date_time: dateTime,
        import_order: importOrder,
      });
      importOrder += 1;
    }
  }

  const manifest = {
    sample_id: sample.sample_id,
    baseline_observing_epoch: baselineWatermark.observingEpoch,
    baseline_committed_epoch: baselineWatermark.committedEpoch,
    turns: manifestTurns,
  } satisfies ImportManifest;
  await writeManifest(home, manifest);

  return {
    sample_id: sample.sample_id,
    imported_count: manifestTurns.length,
    manifest_path: manifestPath(home),
    gateway_trace_path: gatewayTracePath,
  };
}

async function recallCommand(options: Map<string, string>) {
  const home = requireOption(options, 'muninn-home');
  process.env.MUNINN_HOME = home;
  setGatewayTraceFile(home);
  const query = requireOption(options, 'query');
  const limit = parsePositiveInt(requireOption(options, 'limit'), 'limit');
  const manifest = await readManifest(home);
  await waitForImportWatermark(manifest);
  const hits = await recallHits(query, limit, manifest);
  return { hits };
}

async function recallBatchCommand(options: Map<string, string>) {
  const home = requireOption(options, 'muninn-home');
  process.env.MUNINN_HOME = home;
  setGatewayTraceFile(home);
  const queriesFile = requireOption(options, 'queries-file');
  const raw = await readFile(queriesFile, 'utf8');
  const queries = JSON.parse(raw) as RecallBatchQuery[];
  const manifest = await readManifest(home);
  await waitForImportWatermark(manifest);
  const results: Record<string, BridgeHit[]> = {};

  for (const item of queries) {
    results[item.key] = await recallHits(item.query, item.limit, manifest);
  }

  return { results };
}

function setGatewayTraceFile(home: string): string {
  const gatewayTracePath = path.join(home, 'locomo-gateway-trace.jsonl');
  process.env.MUNINN_OBSERVER_GATEWAY_TRACE_FILE = gatewayTracePath;
  return gatewayTracePath;
}

export async function waitForImportWatermark(
  manifest: ImportManifest,
  options?: {
    pollMs?: number;
    timeoutMs?: number;
    warningDelayMs?: number;
  },
): Promise<void> {
  const targetTurnId = manifest.turns[manifest.turns.length - 1]?.turn_id;
  if (!targetTurnId) {
    return;
  }

  const pollMs = options?.pollMs ?? WATERMARK_POLL_MS;
  const timeoutMs = options?.timeoutMs
    ?? envPositiveInt('MUNINN_LOCOMO_WATERMARK_TIMEOUT_MS', WATERMARK_TIMEOUT_MS);
  const warningDelayMs = options?.warningDelayMs
    ?? envPositiveInt('MUNINN_LOCOMO_WATERMARK_WARNING_DELAY_MS', WATERMARK_WARNING_DELAY_MS);
  const startedAt = Date.now();
  let pendingTurnIds: string[] = [];
  let stalledWarningEmitted = false;

  while (Date.now() - startedAt <= timeoutMs) {
    const watermark = await fetchObserverWatermark();
    pendingTurnIds = watermark.pendingTurnIds;
    const preview = pendingTurnIds.slice(0, 5).join(', ') || '(none)';
    console.error(
      `[locomo] waiting for ${targetTurnId}: ${pendingTurnIds.length} pending (${preview})`
    );
    if (watermark.resolved) {
      return;
    }
    if (
      !stalledWarningEmitted
      && Date.now() - startedAt >= warningDelayMs
      && pendingTurnIds.length > 0
    ) {
      stalledWarningEmitted = true;
      console.error(
        `[locomo] warning: no observing progress detected after ${warningDelayMs}ms; pending turn ids: ${preview}; observingEpoch=${formatEpoch(watermark.observingEpoch)} committedEpoch=${formatEpoch(watermark.committedEpoch)}`
      );
    }
    await sleep(pollMs);
  }

  const pendingText = pendingTurnIds.length > 0
    ? pendingTurnIds.join(', ')
    : '(none)';
  throw new Error(
    `observer watermark timeout for ${targetTurnId}; pending turn ids: ${pendingText}`
  );
}

async function fetchObserverWatermark() {
  const { app: sidecarApp } = await import(pathToFileURL(SIDECAR_APP_PATH).href);
  const response = await sidecarApp.request('http://sidecar.local/api/v1/observer/watermark');
  const payload = await response.json() as {
    errorMessage?: string;
    resolved?: boolean;
    pendingTurnIds?: unknown[];
    observingEpoch?: number;
    committedEpoch?: number;
  };
  if (!response.ok) {
    const message = typeof payload?.errorMessage === 'string'
      ? payload.errorMessage
      : `sidecar watermark request failed with status ${response.status}`;
    throw new Error(message);
  }
  return {
    resolved: payload.resolved === true,
    pendingTurnIds: Array.isArray(payload.pendingTurnIds)
      ? payload.pendingTurnIds.map((value) => String(value))
      : [],
    observingEpoch: typeof payload.observingEpoch === 'number' ? payload.observingEpoch : undefined,
    committedEpoch: typeof payload.committedEpoch === 'number' ? payload.committedEpoch : undefined,
  };
}

async function recallHits(
  query: string,
  limit: number,
  manifest: ImportManifest,
): Promise<BridgeHit[]> {
  const rows = await withTransientRetry(
    () => coreClient.memories.recall(query, limit),
    {
      attempts: envPositiveInt('MUNINN_LOCOMO_RECALL_ATTEMPTS', RECALL_ATTEMPTS),
      delayMs: envPositiveInt('MUNINN_LOCOMO_RECALL_RETRY_DELAY_MS', RECALL_RETRY_DELAY_MS),
      label: 'recall',
    },
  );
  const turnMap = manifestTurnMap(manifest);
  const hits: BridgeHit[] = [];

  for (const row of rows) {
    const rendered = await coreClient.memories.get(row.memoryId);
    if (!rendered) {
      continue;
    }
    hits.push(await toBridgeHit(rendered, turnMap, row.text));
  }

  return hits;
}

export async function withTransientRetry<T>(
  operation: () => Promise<T>,
  options: { attempts: number; delayMs: number; label: string },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= options.attempts || !isTransientError(error)) {
        throw error;
      }
      console.error(
        `[locomo] ${options.label} transient failure; retry ${attempt + 1}/${options.attempts}: ${errorMessage(error)}`
      );
      await sleep(options.delayMs);
    }
  }
  throw lastError;
}

function isTransientError(error: unknown): boolean {
  const message = errorMessage(error);
  return /\b(?:408|429|500|502|503|504)\b/.test(message)
    || /upstream connect error|connection termination|ECONNRESET|ETIMEDOUT|fetch failed/i.test(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function toBridgeHit(
  rendered: RenderedMemory,
  turnMap: Map<string, ManifestTurn>,
  matchedText: string,
): Promise<BridgeHit> {
  const evidenceIds = await resolveEvidenceIds(rendered.memoryId, turnMap);
  const dateTimes = uniquePreservingOrder(
    evidenceIds
      .map((sourceId) => findTurnBySourceId(turnMap, sourceId)?.date_time)
      .filter((value): value is string => Boolean(value)),
  );

  return {
    memory_id: rendered.memoryId,
    matched_text: matchedText,
    evidence_ids: evidenceIds,
    date_time: dateTimes.join(' | ') || undefined,
    title: rendered.title ?? undefined,
    summary: rendered.summary ?? undefined,
    detail: rendered.detail ?? undefined,
    observationRatio: observingRatio(rendered.detail),
    references: await directSessionReferences(rendered.memoryId, turnMap),
  };
}

function observingRatio(detail?: string | null): number | null | undefined {
  if (!detail) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const observations = Array.isArray(record.observations) ? record.observations : [];
  const contextRefs = Array.isArray(record.contextRefs) ? record.contextRefs : [];
  if (contextRefs.length === 0) {
    return null;
  }
  return observations.length / contextRefs.length;
}

async function directSessionReferences(
  memoryId: string,
  turnMap: Map<string, ManifestTurn>,
): Promise<BridgeReference[]> {
  if (!memoryId.startsWith('observing:')) {
    return [];
  }
  const observing = await coreClient.observings.get(memoryId);
  if (!observing) {
    return [];
  }

  const references: BridgeReference[] = [];
  for (const reference of observing.references) {
    const manifestTurn = turnMap.get(reference);
    if (!manifestTurn) {
      continue;
    }
    const turn = await coreClient.sessions.get(reference);
    references.push({
      memory_id: reference,
      source_id: manifestTurn.source_id,
      date_time: manifestTurn.date_time,
      text: renderReferenceText(turn),
    });
  }
  return references;
}

function renderReferenceText(turn: SessionTurn | null): string {
  if (!turn) {
    return '';
  }
  const prompt = turn.prompt?.trim();
  const response = turn.response?.trim();
  if (prompt && response) {
    return `${prompt}\nResponse: ${response}`;
  }
  return prompt || response || '';
}

async function addTurnAndFind(content: TurnContent): Promise<SessionTurn> {
  await coreClient.addMessage(content);
  const turns = await coreClient.sessions.list({
    mode: { type: 'recency', limit: 20 },
    agent: content.agent,
    sessionId: content.sessionId,
  });
  const match = turns.find((turn) => (
    turn.prompt === content.prompt
    && turn.response === content.response
  ));
  if (!match) {
    throw new Error(
      `failed to resolve imported LoCoMo turn for ${content.agent} in ${content.sessionId}`
    );
  }
  return match;
}

async function resolveEvidenceIds(
  memoryId: string,
  turnMap: Map<string, ManifestTurn>,
  seen = new Set<string>(),
): Promise<string[]> {
  if (seen.has(memoryId)) {
    return [];
  }
  seen.add(memoryId);

  const direct = turnMap.get(memoryId);
  if (direct) {
    return [direct.source_id];
  }

  if (!memoryId.startsWith('observing:')) {
    return [];
  }

  const observing = await coreClient.observings.get(memoryId);
  if (!observing) {
    return [];
  }

  const sourceIds: string[] = [];
  for (const reference of observing.references) {
    for (const sourceId of await resolveEvidenceReference(reference, turnMap, seen)) {
      if (!sourceIds.includes(sourceId)) {
        sourceIds.push(sourceId);
      }
    }
  }
  return sourceIds;
}

async function resolveEvidenceReference(
  reference: string,
  turnMap: Map<string, ManifestTurn>,
  seen: Set<string>,
): Promise<string[]> {
  if (!reference) {
    return [];
  }
  return resolveEvidenceIds(reference, turnMap, seen);
}

export function resolveEvidenceIdsFromGraph(
  memoryId: string,
  turns: ManifestTurn[],
  referenceGraph: Record<string, string[]>,
): string[] {
  const turnMap = new Map(turns.map((turn) => [turn.turn_id, turn]));
  return resolveEvidenceIdsFromGraphInner(memoryId, turnMap, referenceGraph, new Set<string>());
}

function resolveEvidenceIdsFromGraphInner(
  memoryId: string,
  turnMap: Map<string, ManifestTurn>,
  referenceGraph: Record<string, string[]>,
  seen: Set<string>,
): string[] {
  if (seen.has(memoryId)) {
    return [];
  }
  seen.add(memoryId);

  const direct = turnMap.get(memoryId);
  if (direct) {
    return [direct.source_id];
  }

  const references = referenceGraph[memoryId] ?? [];
  const evidenceIds: string[] = [];
  for (const reference of references) {
    for (const sourceId of resolveEvidenceIdsFromGraphInner(reference, turnMap, referenceGraph, seen)) {
      if (!evidenceIds.includes(sourceId)) {
        evidenceIds.push(sourceId);
      }
    }
  }
  return evidenceIds;
}

async function loadSample(dataFile: string, sampleId: string): Promise<LocomoSample> {
  const raw = await readFile(dataFile, 'utf8');
  const samples = JSON.parse(raw) as LocomoSample[];
  const sample = samples.find((item) => item.sample_id === sampleId);
  if (!sample) {
    throw new Error(`sample not found: ${sampleId}`);
  }
  return sample;
}

async function bootstrapHome(
  home: string,
  templateConfigPath: string,
  sourceConfigPath: string,
): Promise<void> {
  const targetConfigPath = path.join(home, CONFIG_FILE_NAME);
  if (await pathExists(targetConfigPath)) {
    return;
  }
  const templateRaw = await readFile(templateConfigPath, 'utf8');
  const templateConfig = parseJsonObject(templateRaw, templateConfigPath);
  const mergedConfig = structuredClone(templateConfig);

  if (await pathExists(sourceConfigPath)) {
    const sourceRaw = await readFile(sourceConfigPath, 'utf8');
    const sourceConfig = parseJsonObject(sourceRaw, sourceConfigPath);
    delete sourceConfig.storage;
    mergeJsonObjects(mergedConfig, sourceConfig);
  }

  normalizeObserverConfig(mergedConfig);
  validateBenchmarkConfig(mergedConfig);
  await writeFile(targetConfigPath, `${JSON.stringify(mergedConfig, null, 2)}\n`, 'utf8');
}

function resolveActiveConfigPath(): string {
  const currentHome = process.env.MUNINN_HOME;
  if (currentHome && currentHome.trim().length > 0) {
    return path.join(currentHome, CONFIG_FILE_NAME);
  }
  return path.join(os.homedir(), '.muninn', CONFIG_FILE_NAME);
}

async function resolveBenchmarkConfigPath(): Promise<string> {
  const candidates = [
    path.resolve(__dirname, '..', CONFIG_FILE_NAME),
    path.resolve(__dirname, '..', '..', '..', 'benchmark', 'locomo', CONFIG_FILE_NAME),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `missing benchmark config template; expected ${CONFIG_FILE_NAME} under benchmark/locomo`
  );
}

function parseJsonObject(raw: string, sourcePath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `invalid benchmark config at ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`invalid benchmark config at ${sourcePath}: root must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function mergeJsonObjects(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(overlay)) {
    const current = base[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      mergeJsonObjects(current, value);
      continue;
    }
    base[key] = value;
  }
}

function validateBenchmarkConfig(config: Record<string, unknown>): void {
  const semanticIndex = requireObjectField(config, 'semanticIndex', 'semanticIndex');
  const embedding = requireObjectField(
    semanticIndex,
    'embedding',
    'semanticIndex.embedding',
  );
  requireStringField(embedding, 'provider', 'semanticIndex.embedding.provider');
}

function requireObjectField(
  root: Record<string, unknown>,
  key: string,
  pathLabel: string,
): Record<string, unknown> {
  const value = root[key];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(
    `LoCoMo benchmark requires ${pathLabel} to be configured in ${CONFIG_FILE_NAME}`
  );
}

function requireStringField(
  root: Record<string, unknown>,
  key: string,
  pathLabel: string,
): string {
  const value = root[key];
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  throw new Error(
    `LoCoMo benchmark requires ${pathLabel} to be configured in ${CONFIG_FILE_NAME}`
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeObserverConfig(config: Record<string, unknown>): void {
  if (hasConfiguredObserverConfig(config)) {
    return;
  }
  delete config.observer;
}

function hasConfiguredObserverConfig(config: Record<string, unknown>): boolean {
  const observer = config.observer;
  if (!isPlainObject(observer)) {
    return false;
  }
  const llmName = observer.llm;
  if (typeof llmName !== 'string' || llmName.trim().length === 0) {
    return false;
  }
  const llm = config.llm;
  if (!isPlainObject(llm)) {
    return false;
  }
  const observerLlm = llm[llmName];
  if (!isPlainObject(observerLlm)) {
    return false;
  }
  const provider = observerLlm.provider;
  return typeof provider === 'string' && provider.trim().length > 0;
}

function manifestPath(home: string): string {
  return path.join(home, 'locomo-manifest.json');
}

async function writeManifest(home: string, manifest: ImportManifest): Promise<void> {
  await writeFile(manifestPath(home), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function readManifest(home: string): Promise<ImportManifest> {
  const raw = await readFile(manifestPath(home), 'utf8');
  return JSON.parse(raw) as ImportManifest;
}

function manifestTurnMap(manifest: ImportManifest): Map<string, ManifestTurn> {
  return new Map(manifest.turns.map((turn) => [turn.turn_id, turn]));
}

function findTurnBySourceId(
  turnMap: Map<string, ManifestTurn>,
  sourceId: string,
): ManifestTurn | undefined {
  for (const turn of turnMap.values()) {
    if (turn.source_id === sourceId) {
      return turn;
    }
  }
  return undefined;
}

function dialogText(dialog: LocomoDialog): string {
  const base = dialog.text ?? dialog.clean_text ?? dialog.compressed_text ?? '';
  if (dialog.blip_caption) {
    return `${base} [shares ${dialog.blip_caption}]`;
  }
  return base;
}

function dialogLine(dialog: LocomoDialog, dateTime: string): string {
  return [
    `DATE: ${dateTime}`,
    'DIALOGUE:',
    `${dialog.speaker} said: "${dialogText(dialog)}"`,
    '',
    'Only the DIALOGUE line is source content. The response field is an import placeholder, not dialogue.',
  ].join('\n').trim();
}

export function sessionKey(sampleId: string, sessionNo: number): string {
  return `locomo:${sampleId}:session_${sessionNo}`;
}

function getSessionNumbers(conversation: LocomoSample['conversation']): number[] {
  return Object.keys(conversation)
    .filter((key) => /^session_\d+$/.test(key))
    .map((key) => parseInt(key.split('_')[1] ?? '0', 10))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
}

function getDateTime(conversation: LocomoSample['conversation'], sessionNo: number): string {
  const value = conversation[`session_${sessionNo}_date_time`];
  if (typeof value !== 'string') {
    throw new Error(`missing session_${sessionNo}_date_time`);
  }
  return value;
}

function uniquePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    output.push(value);
  }
  return output;
}

function parsePositiveInt(value: string, label: string): number {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer, got: ${value}`);
  }
  return parsed;
}

function parseArgs(args: string[]) {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token?.startsWith('--')) {
      throw new Error(`expected option flag, got: ${token}`);
    }
    const key = token.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`missing value for --${key}`);
    }
    options.set(key, value);
    index += 1;
  }
  return options;
}

function requireOption(options: Map<string, string>, key: string) {
  const value = options.get(key);
  if (!value) {
    throw new Error(`missing required option --${key}`);
  }
  return value;
}

function emitJson(payload: unknown) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatEpoch(value: number | undefined): string {
  return value === undefined ? 'none' : String(value);
}

const isDirectExecution =
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  require.main === module;

if (isDirectExecution) {
  void main();
}
