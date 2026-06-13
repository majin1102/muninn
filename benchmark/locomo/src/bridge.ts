#!/usr/bin/env node

import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { existsSync } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { RecallMode } from '@muninn/server';

const CONFIG_FILE_NAME = 'muninn.json';
const WATERMARK_POLL_MS = 2_000;
const WATERMARK_TIMEOUT_MS = 30 * 60 * 1_000;
const WATERMARK_WARNING_DELAY_MS = 60_000;
const RECALL_ATTEMPTS = 3;
const RECALL_RETRY_DELAY_MS = 1_000;
const RECALL_QUERY_TIMEOUT_MS = 120_000;
const NO_PAIRED_RESPONSE = '[no paired response dialogue]';

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
  baseline_extracting_epoch?: number;
  baseline_committed_epoch?: number;
  turns: ManifestTurn[];
};

type BridgeHit = {
  memory_id: string;
  matched_text: string;
  detail?: string;
  observationRatio?: number | null;
};

type TurnContent = {
  sessionId: string;
  agent: string;
  prompt: string;
  response: string;
  events?: Array<{ type: 'userMessage' | 'assistantMessage'; text: string }>;
};

type CapturedTurn = {
  turnId: string;
  prompt?: string | null;
  response?: string | null;
};

type RecallBatchQuery = {
  key: string;
  query: string;
  limit: number;
};

type BridgeEnvelope =
  | { ok: true; result: unknown }
  | { ok: false; error: { message: string; stack?: string } };

export const __testing = {
  WATERMARK_TIMEOUT_MS,
};

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);

  try {
    const result = await runCommand(command, options);
    emitBridgeEnvelope({ ok: true, result });
  } catch (error) {
    await shutdownQuietly();
    const payload = errorPayload(error);
    console.error(payload.stack ?? payload.message);
    emitBridgeEnvelope({ ok: false, error: payload });
    process.exitCode = 1;
  }
}

async function runCommand(command: string | undefined, options: Map<string, string>): Promise<unknown> {
  switch (command) {
    case 'reset-home':
      await resetHome(requireOption(options, 'muninn-home'));
      return { ok: true };
    case 'import-sample':
      return importSampleCommand(options);
    case 'recall':
      return recallCommand(options);
    case 'recall-batch':
      return recallBatchCommand(options);
    default:
      throw new Error(`unknown command: ${command ?? '<missing>'}`);
  }
}

async function shutdownQuietly(): Promise<void> {
}

function errorPayload(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function emitBridgeEnvelope(envelope: BridgeEnvelope): void {
  emitJson(envelope);
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

  const sample = await loadSample(dataFile, sampleId);
  const database = sample.sample_id;
  const gatewayTracePath = setGatewayTraceFile(home, database);
  const manifestTurns: ManifestTurn[] = [];
  let importOrder = 0;
  const totalDialogs = countSampleDialogs(sample);

  for (const sessionNo of getSessionNumbers(sample.conversation)) {
    const dateTime = getDateTime(sample.conversation, sessionNo);
    const dialogs = sample.conversation[`session_${sessionNo}`] as LocomoDialog[];
    const sessionId = sessionKey(sample.sample_id, sessionNo);
    for (let index = 0; index < dialogs.length; index += 2) {
      const promptDialog = dialogs[index];
      const responseDialog = dialogs[index + 1];
      if (!promptDialog) {
        continue;
      }
      console.error(
        `[locomo] import_turn_start sample_id=${sample.sample_id} imported=${importOrder}/${totalDialogs} session=${sessionNo} prompt_source_id=${promptDialog.dia_id} response_source_id=${responseDialog?.dia_id ?? '(none)'}`
      );
      const turn = await captureTurn({
        sessionId,
        agent: promptDialog.speaker,
        prompt: dialogLine(promptDialog, dateTime),
        response: responseDialog ? dialogLine(responseDialog, dateTime) : noPairedResponseLine(dateTime),
      }, database);
      for (const dialog of [promptDialog, responseDialog].filter(Boolean) as LocomoDialog[]) {
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
      console.error(
        `[locomo] import_progress sample_id=${sample.sample_id} imported=${importOrder}/${totalDialogs} last_turn_id=${turn.turnId}`
      );
    }
  }
  console.error(
    `[locomo] import_capture_complete sample_id=${sample.sample_id} imported=${importOrder}/${totalDialogs}`
  );

  const manifest = {
    sample_id: sample.sample_id,
    turns: manifestTurns,
  } satisfies ImportManifest;
  await writeManifest(home, manifest);
  await waitForImportWatermark(manifest, { database });

  return {
    sample_id: sample.sample_id,
    imported_count: manifestTurns.length,
    manifest_path: manifestPath(home),
    gateway_trace_path: gatewayTracePath,
  };
}

function countSampleDialogs(sample: LocomoSample): number {
  return getSessionNumbers(sample.conversation).reduce((total, sessionNo) => {
    const dialogs = sample.conversation[`session_${sessionNo}`];
    return total + (Array.isArray(dialogs) ? dialogs.length : 0);
  }, 0);
}

async function recallCommand(options: Map<string, string>) {
  const home = requireOption(options, 'muninn-home');
  process.env.MUNINN_HOME = home;
  const query = requireOption(options, 'query');
  const limit = parsePositiveInt(requireOption(options, 'limit'), 'limit');
  const recallMode = parseRecallMode(options.get('recall-mode'));
  const budget = parseOptionalNonNegativeInt(options.get('budget'), 'budget') ?? 0;
  const queryLimit = parseOptionalPositiveInt(options.get('query-limit'), 'query-limit');
  const skipWatermark = options.has('skip-watermark');
  const manifest = filterManifestBySample(await readManifest(home), options.get('sample-id'));
  const database = manifest.sample_id;
  setGatewayTraceFile(home, database);
  if (!skipWatermark) {
    await waitForImportWatermark(manifest, { database });
  }
  const hits = await recallHits(query, limit, manifest, recallMode, budget, queryLimit);
  return { hits };
}

async function recallBatchCommand(options: Map<string, string>) {
  const home = requireOption(options, 'muninn-home');
  process.env.MUNINN_HOME = home;
  const queriesFile = requireOption(options, 'queries-file');
  const recallMode = parseRecallMode(options.get('recall-mode'));
  const budget = parseOptionalNonNegativeInt(options.get('budget'), 'budget') ?? 0;
  const queryLimit = parseOptionalPositiveInt(options.get('query-limit'), 'query-limit');
  const skipWatermark = options.has('skip-watermark');
  const raw = await readFile(queriesFile, 'utf8');
  const queries = JSON.parse(raw) as RecallBatchQuery[];
  const manifest = filterManifestBySample(await readManifest(home), options.get('sample-id'));
  const database = manifest.sample_id;
  setGatewayTraceFile(home, database);
  if (!skipWatermark) {
    await waitForImportWatermark(manifest, { database });
  }
  const results: Record<string, BridgeHit[]> = {};
  const queryTimeoutMs = envPositiveInt('MUNINN_LOCOMO_RECALL_QUERY_TIMEOUT_MS', RECALL_QUERY_TIMEOUT_MS);

  console.error(
    `[locomo] recall_batch_start total=${queries.length} mode=${recallMode} budget=${budget} query_limit=${queryLimit ?? '(none)'} timeout_ms=${queryTimeoutMs}`
  );

  for (let index = 0; index < queries.length; index += 1) {
    const item = queries[index]!;
    const startedAt = Date.now();
    console.error(
      `[locomo] recall_query_start index=${index + 1}/${queries.length} key=${JSON.stringify(item.key)} limit=${item.limit} query=${JSON.stringify(item.query)}`
    );
    try {
      const hits = await withTimeout(
        recallHits(item.query, item.limit, manifest, recallMode, budget, queryLimit),
        queryTimeoutMs,
        `recall query timed out after ${queryTimeoutMs}ms: key=${item.key} query=${item.query}`
      );
      results[item.key] = hits;
      console.error(
        `[locomo] recall_query_complete index=${index + 1}/${queries.length} key=${JSON.stringify(item.key)} elapsed_ms=${Date.now() - startedAt} hit_count=${hits.length}`
      );
    } catch (error) {
      console.error(
        `[locomo] recall_query_failed index=${index + 1}/${queries.length} key=${JSON.stringify(item.key)} elapsed_ms=${Date.now() - startedAt} error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`
      );
      throw error;
    }
  }

  console.error(`[locomo] recall_batch_complete total=${queries.length}`);
  return { results };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function setGatewayTraceFile(home: string, database: string): string {
  const logsDir = path.join(home, database, 'logs');
  const gatewayTracePath = path.join(logsDir, 'locomo-gateway-trace.jsonl');
  const observingTracePath = path.join(logsDir, 'locomo-thread-observing-trace.jsonl');
  const observerTracePath = path.join(logsDir, 'locomo-observer-trace.jsonl');
  process.env.MUNINN_OBSERVER_GATEWAY_TRACE_FILE = gatewayTracePath;
  process.env.MUNINN_THREAD_OBSERVING_TRACE_FILE = observingTracePath;
  process.env.MUNINN_OBSERVER_TRACE_FILE = observerTracePath;
  return gatewayTracePath;
}

export async function waitForImportWatermark(
  manifest: ImportManifest,
  options?: {
    database?: string;
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
  let pendingExtractionIds: string[] = [];
  let stalledWarningEmitted = false;
  const database = options?.database ?? manifest.sample_id;
  const finalized = await withTransientRetry(
    () => fetchMemoryFinalize(database),
    {
      attempts: envPositiveInt('MUNINN_LOCOMO_WATERMARK_ATTEMPTS', RECALL_ATTEMPTS),
      delayMs: envPositiveInt('MUNINN_LOCOMO_WATERMARK_RETRY_DELAY_MS', RECALL_RETRY_DELAY_MS),
      label: 'memory finalize',
    },
  );
  pendingTurnIds = finalized.pending.turns;
  pendingExtractionIds = finalized.pending.extractions;
  if (finalized.error) {
    throw new Error(`memory ${finalized.error.phase} error: ${finalized.error.message}`);
  }
  if (memoryWatermarkResolved(finalized)) {
    console.error(
      `[locomo] finalized memory database=${database} for ${targetTurnId}`
    );
    return;
  }

  while (Date.now() - startedAt <= timeoutMs) {
    const watermark = await fetchMemoryWatermark(database);
    pendingTurnIds = watermark.pending.turns;
    pendingExtractionIds = watermark.pending.extractions;
    if (watermark.error) {
      throw new Error(`memory ${watermark.error.phase} error: ${watermark.error.message}`);
    }
    const turnPreview = pendingTurnIds.slice(0, 5).join(', ') || '(none)';
    const extractionPreview = pendingExtractionIds.slice(0, 5).join(', ') || '(none)';
    console.error(
      `[locomo] waiting for ${targetTurnId}: turns=${pendingTurnIds.length} (${turnPreview}) extractions=${pendingExtractionIds.length} (${extractionPreview}) phases=${watermark.phases.extractor}/${watermark.phases.observer}`
    );
    if (memoryWatermarkResolved(watermark)) {
      return;
    }
    if (
      !stalledWarningEmitted
      && Date.now() - startedAt >= warningDelayMs
      && (pendingTurnIds.length > 0 || pendingExtractionIds.length > 0)
    ) {
      stalledWarningEmitted = true;
      console.error(
        `[locomo] warning: no memory progress detected after ${warningDelayMs}ms; pending turns=${turnPreview}; pending extractions=${extractionPreview}; phases=${watermark.phases.extractor}/${watermark.phases.observer}`
      );
    }
    await sleep(pollMs);
  }

  const pendingText = `turns=${pendingTurnIds.length > 0 ? pendingTurnIds.join(', ') : '(none)'}; extractions=${pendingExtractionIds.length > 0 ? pendingExtractionIds.join(', ') : '(none)'}`;
  throw new Error(
    `memory watermark timeout for ${targetTurnId}; pending: ${pendingText}`
  );
}

async function fetchMemoryWatermark(database: string) {
  const url = new URL(`${serverBaseUrl()}/api/v1/memory/watermark`);
  url.searchParams.set('database', database);
  const response = await fetch(url);
  const payload = await response.json();
  return parseMemoryWatermarkPayload(payload, response.status, response.ok, 'watermark');
}

async function fetchMemoryFinalize(database?: string) {
  const { payload, statusCode } = await requestJson(`${serverBaseUrl()}/api/v1/memory/finalize`, {
    method: 'POST',
    body: JSON.stringify({ database }),
  });
  return parseMemoryWatermarkPayload(payload, statusCode, statusCode >= 200 && statusCode < 300, 'finalize');
}

async function requestJson(url: string, options: { method: string; body?: string }): Promise<{ payload: unknown; statusCode: number }> {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(target, {
      method: options.method,
      headers: options.body ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(options.body),
      } : undefined,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({
            payload: body ? JSON.parse(body) : {},
            statusCode: response.statusCode ?? 0,
          });
        } catch (error) {
          reject(new Error(`server response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`));
        }
      });
    });
    request.on('error', reject);
    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

async function parseMemoryWatermarkPayload(
  rawPayload: unknown,
  status: number,
  ok: boolean,
  label: string,
) {
  const payload = rawPayload as {
    errorMessage?: string;
    pending?: {
      turns?: unknown[];
      extractions?: unknown[];
    };
    phases?: {
      extractor?: unknown;
      observer?: unknown;
    };
    error?: {
      phase?: unknown;
      message?: unknown;
    };
  };
  if (!ok) {
    const detail = typeof payload?.errorMessage === 'string'
      ? payload.errorMessage
      : `server ${label} request failed with status ${status}`;
    const message = `server ${label} request failed with status ${status}: ${detail}`;
    throw new Error(message);
  }
  const extractorPhase = parseWatermarkPhase(payload.phases?.extractor, 'extractor');
  const observerPhase = parseWatermarkPhase(payload.phases?.observer, 'observer');
  return {
    pending: {
      turns: Array.isArray(payload.pending?.turns)
        ? payload.pending.turns.map((value) => String(value))
        : [],
      extractions: Array.isArray(payload.pending?.extractions)
        ? payload.pending.extractions.map((value) => String(value))
        : [],
    },
    phases: {
      extractor: extractorPhase,
      observer: observerPhase,
    },
    ...(payload.error && typeof payload.error.message === 'string' && (payload.error.phase === 'extractor' || payload.error.phase === 'observer')
      ? { error: { phase: payload.error.phase, message: payload.error.message } }
      : {}),
  };
}

function parseWatermarkPhase(value: unknown, component: 'extractor' | 'observer') {
  const allowed = component === 'observer'
    ? ['idle', 'pending', 'running', 'draining', 'error']
    : ['idle', 'pending', 'running', 'error'];
  if (typeof value === 'string' && allowed.includes(value)) {
    return value;
  }
  throw new Error(`server watermark response had invalid ${component} phase: ${String(value)}`);
}

function memoryWatermarkResolved(watermark: Awaited<ReturnType<typeof fetchMemoryWatermark>>): boolean {
  return watermark.pending.turns.length === 0
    && watermark.pending.extractions.length === 0
    && watermark.phases.extractor === 'idle'
    && watermark.phases.observer === 'idle'
    && !watermark.error;
}

async function recallHits(
  query: string,
  limit: number,
  manifest: ImportManifest,
  mode: RecallMode,
  budget = 0,
  queryLimit?: number,
): Promise<BridgeHit[]> {
  const payload = await withTransientRetry(
    () => fetchLocomoRecall(query, limit, manifest, mode, budget, queryLimit),
    {
      attempts: envPositiveInt('MUNINN_LOCOMO_RECALL_ATTEMPTS', RECALL_ATTEMPTS),
      delayMs: envPositiveInt('MUNINN_LOCOMO_RECALL_RETRY_DELAY_MS', RECALL_RETRY_DELAY_MS),
      label: 'recall',
    },
  );
  return payload.hits;
}

function parseRecallMode(raw: string | undefined): RecallMode {
  if (!raw) {
    return 'hybrid';
  }
  if (raw === 'vector' || raw === 'fts' || raw === 'hybrid') {
    return raw;
  }
  throw new Error(`invalid recall mode: ${raw}`);
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

async function captureTurn(content: TurnContent, database: string): Promise<CapturedTurn> {
  const turnPayload = {
    ...content,
    events: content.events ?? [
      { type: 'userMessage' as const, text: content.prompt },
      { type: 'assistantMessage' as const, text: content.response },
    ],
  };
  const payload = await fetchJsonObject(`${serverBaseUrl()}/api/v1/benchmark/locomo/turn/capture`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ database, turn: turnPayload }),
  }, 'benchmark capture');
  const turn = payload.turn;
  if (!turn || typeof turn !== 'object' || typeof (turn as Record<string, unknown>).turnId !== 'string') {
    throw new Error('benchmark capture response did not include turn.turnId');
  }
  return turn as CapturedTurn;
}

async function fetchLocomoRecall(
  query: string,
  limit: number,
  manifest: ImportManifest,
  mode: RecallMode,
  budget = 0,
  queryLimit?: number,
): Promise<{ hits: BridgeHit[] }> {
  const payload = await fetchJsonObject(`${serverBaseUrl()}/api/v1/benchmark/locomo/recall`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query,
      database: manifest.sample_id,
      limit,
      recallMode: mode,
      budget,
      queryLimit,
      manifest,
    }),
  }, 'benchmark recall');
  const hits = payload.hits;
  if (!Array.isArray(hits)) {
    throw new Error('benchmark recall response did not include hits array');
  }
  return { hits: hits.map(parseBridgeHit) };
}

async function fetchJsonObject(url: string, init: RequestInit, label: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const detail = typeof record.errorMessage === 'string' ? record.errorMessage : `status ${response.status}`;
    throw new Error(`${label} request failed with status ${response.status}: ${detail}`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${label} response must be a JSON object`);
  }
  return payload as Record<string, unknown>;
}

function parseBridgeHit(value: unknown): BridgeHit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('benchmark recall hit must be an object');
  }
  const hit = value as Record<string, unknown>;
  return {
    memory_id: String(hit.memory_id ?? ''),
    matched_text: String(hit.matched_text ?? ''),
    detail: typeof hit.detail === 'string' ? hit.detail : undefined,
    observationRatio: typeof hit.observationRatio === 'number' || hit.observationRatio === null
      ? hit.observationRatio
      : undefined,
  };
}

function serverBaseUrl(): string {
  return (process.env.MUNINN_SERVER_BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
}

export function resolveEvidenceIdsFromGraph(
  memoryId: string,
  turns: ManifestTurn[],
  referenceGraph: Record<string, string[]>,
): string[] {
  const turnMap = manifestTurnEntries(turns);
  return resolveEvidenceIdsFromGraphInner(memoryId, turnMap, referenceGraph, new Set<string>());
}

function resolveEvidenceIdsFromGraphInner(
  memoryId: string,
  turnMap: Map<string, ManifestTurn[]>,
  referenceGraph: Record<string, string[]>,
  seen: Set<string>,
): string[] {
  if (seen.has(memoryId)) {
    return [];
  }
  seen.add(memoryId);

  const direct = turnMap.get(memoryId) ?? [];
  if (direct.length > 0) {
    return direct.map((turn) => turn.source_id);
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

  validateBenchmarkConfig(mergedConfig);
  await writeFile(targetConfigPath, `${JSON.stringify(mergedConfig, null, 2)}\n`, 'utf8');
}

function resolveActiveConfigPath(): string {
  const currentHome = process.env.MUNINN_HOME;
  if (currentHome && currentHome.trim().length > 0) {
    return path.join(currentHome, CONFIG_FILE_NAME);
  }
  const localConfigPath = path.resolve(process.cwd(), CONFIG_FILE_NAME);
  if (existsSync(localConfigPath)) {
    return localConfigPath;
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
  const extractor = requireObjectField(config, 'extractor', 'extractor');
  const llmProvider = requireStringField(extractor, 'llmProvider', 'extractor.llmProvider');
  const embeddingProvider = requireStringField(extractor, 'embeddingProvider', 'extractor.embeddingProvider');
  const providers = requireObjectField(config, 'providers', 'providers');
  const llm = requireObjectField(providers, 'llm', 'providers.llm');
  const embedding = requireObjectField(providers, 'embedding', 'providers.embedding');
  const llmConfig = requireObjectField(llm, llmProvider, `providers.llm.${llmProvider}`);
  const embeddingConfig = requireObjectField(embedding, embeddingProvider, `providers.embedding.${embeddingProvider}`);
  requireStringField(llmConfig, 'type', `providers.llm.${llmProvider}.type`);
  requireStringField(embeddingConfig, 'type', `providers.embedding.${embeddingProvider}.type`);

  if (isPlainObject(config.observer)) {
    const observerLlmProvider = requireStringField(config.observer, 'llmProvider', 'observer.llmProvider');
    const observerLlmConfig = requireObjectField(llm, observerLlmProvider, `providers.llm.${observerLlmProvider}`);
    requireStringField(observerLlmConfig, 'type', `providers.llm.${observerLlmProvider}.type`);
  }
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

function filterManifestBySample(manifest: ImportManifest, sampleId?: string): ImportManifest {
  if (!sampleId) {
    return manifest;
  }
  return {
    ...manifest,
    sample_id: sampleId,
    turns: manifest.turns.filter((turn) => turn.sample_id === sampleId),
  };
}

function manifestTurnMap(manifest: ImportManifest): Map<string, ManifestTurn[]> {
  return manifestTurnEntries(manifest.turns);
}

function manifestTurnEntries(turns: ManifestTurn[]): Map<string, ManifestTurn[]> {
  const byTurnId = new Map<string, ManifestTurn[]>();
  for (const turn of turns) {
    const entries = byTurnId.get(turn.turn_id) ?? [];
    entries.push(turn);
    byTurnId.set(turn.turn_id, entries);
  }
  return byTurnId;
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
  ].join('\n').trim();
}

function noPairedResponseLine(dateTime: string): string {
  return [
    `DATE: ${dateTime}`,
    'DIALOGUE:',
    NO_PAIRED_RESPONSE,
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

function parsePositiveInt(value: string, label: string): number {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer, got: ${value}`);
  }
  return parsed;
}

function parseOptionalPositiveInt(value: string | undefined, label: string): number | undefined {
  return value === undefined ? undefined : parsePositiveInt(value, label);
}

function parseOptionalNonNegativeInt(value: string | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer, got: ${value}`);
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

const isDirectExecution =
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  require.main === module;

if (isDirectExecution) {
  void main();
}
