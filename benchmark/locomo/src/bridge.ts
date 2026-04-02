#!/usr/bin/env node

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ObservingRecord,
  RenderedMemoryRecord,
  SessionMessageInput,
  SessionTurnRecord,
} from '@muninn/core';
import * as coreClient from '@muninn/core';

type LocomoDialog = {
  speaker: string;
  dia_id: string;
  text?: string;
  clean_text?: string;
  compressed_text?: string;
  blip_caption?: string;
  img_file?: string;
};

type LocomoObservationBySpeaker = Record<string, [string, string][]>;

type LocomoSample = {
  sample_id: string;
  conversation: Record<string, string | LocomoDialog[]>;
  observation: Record<string, LocomoObservationBySpeaker>;
  session_summary: Record<string, string>;
};

type ImportMode = 'dialog' | 'observation' | 'summary';
type Pipeline = 'oracle' | 'generated';
type ArtifactMap = Record<string, string>;

type BridgeHit = {
  memory_id: string;
  source_id: string;
  sample_id: string;
  mode: string;
  session_no: number;
  date_time: string;
  title?: string;
  summary?: string;
  detail?: string;
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
  const mode = requireOption(options, 'mode') as ImportMode;
  const pipeline = readPipelineOption(options);
  const home = requireOption(options, 'muninn-home');
  process.env.MUNINN_HOME = home;
  process.env.MUNINN_CORE_ALLOW_CARGO_FALLBACK ??= '1';
  await mkdir(home, { recursive: true });
  await writeBenchmarkConfig(home, pipeline, mode);

  const sample = await loadSample(dataFile, sampleId);
  const rows = buildRows(sample, pipeline, mode);
  for (const row of rows) {
    await coreClient.addMessage(row);
  }
  if (pipeline === 'generated' && mode === 'observation') {
    await coreClient.flushObserverForTests();
  }
  await coreClient.runWatchdogOnceForTests();

  return {
    sample_id: sample.sample_id,
    pipeline,
    mode,
    imported_count: rows.length,
  };
}

async function recallCommand(options: Map<string, string>) {
  const pipeline = readPipelineOption(options);
  const mode = requireOption(options, 'mode') as ImportMode;
  process.env.MUNINN_HOME = requireOption(options, 'muninn-home');
  process.env.MUNINN_CORE_ALLOW_CARGO_FALLBACK ??= '1';
  const query = requireOption(options, 'query');
  const limit = parsePositiveInt(requireOption(options, 'limit'), 'limit');
  const hits = await recallHits(query, limit, pipeline, mode);
  return { hits };
}

async function recallBatchCommand(options: Map<string, string>) {
  const pipeline = readPipelineOption(options);
  const mode = requireOption(options, 'mode') as ImportMode;
  process.env.MUNINN_HOME = requireOption(options, 'muninn-home');
  process.env.MUNINN_CORE_ALLOW_CARGO_FALLBACK ??= '1';
  const queriesFile = requireOption(options, 'queries-file');
  const raw = await readFile(queriesFile, 'utf8');
  const queries = JSON.parse(raw) as Array<{ key: string; query: string; limit: number }>;
  const results: Record<string, BridgeHit[]> = {};

  for (const item of queries) {
    results[item.key] = await recallHits(item.query, item.limit, pipeline, mode);
  }

  return { results };
}

async function recallHits(
  query: string,
  limit: number,
  pipeline: Pipeline,
  mode: ImportMode,
): Promise<BridgeHit[]> {
  const targetLayer = targetLayerFor(pipeline, mode);
  const rows = await coreClient.memories.recall(query, Math.max(limit * 8, limit));
  const hits: BridgeHit[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (memoryLayerFor(row.memoryId) !== targetLayer) {
      continue;
    }
    const rendered = await coreClient.memories.get(row.memoryId);
    if (!rendered) {
      continue;
    }
    const expanded = await expandRecallRow(row.memoryId, rendered, mode);
    for (const hit of expanded) {
      if (!hit.source_id) {
        continue;
      }
      const dedupeKey = `${hit.memory_id}:${hit.source_id}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      hits.push(hit);
      if (hits.length >= limit) {
        return hits;
      }
    }
  }

  return hits;
}

async function expandRecallRow(
  memoryId: string,
  rendered: RenderedMemoryRecord,
  requestedMode: ImportMode,
): Promise<BridgeHit[]> {
  if (memoryLayerFor(memoryId) === 'SESSION') {
    const session = await coreClient.sessions.get(memoryId);
    if (!session) {
      return [];
    }
    return [toBridgeHit(rendered, session.artifacts ?? {}, requestedMode)];
  }

  const observing = await coreClient.observings.get(memoryId);
  if (!observing) {
    return [];
  }
  const sessions = await collectReferencedSessions(observing);
  const hits: BridgeHit[] = [];
  const seenSourceIds = new Set<string>();
  for (const session of sessions) {
    const artifacts = session.artifacts ?? {};
    const sourceId = artifacts.benchmark_source_id ?? '';
    if (!sourceId || seenSourceIds.has(sourceId)) {
      continue;
    }
    seenSourceIds.add(sourceId);
    hits.push(toBridgeHit(rendered, artifacts, requestedMode));
  }
  return hits;
}

async function collectReferencedSessions(
  observing: ObservingRecord,
  visited = new Set<string>(),
): Promise<SessionTurnRecord[]> {
  const sessions: SessionTurnRecord[] = [];
  for (const reference of observing.references) {
    if (reference.startsWith('SESSION:')) {
      const session = await coreClient.sessions.get(reference);
      if (session) {
        sessions.push(session);
      }
      continue;
    }
    if (!reference.startsWith('OBSERVING:') || visited.has(reference)) {
      continue;
    }
    visited.add(reference);
    const parent = await coreClient.observings.get(reference);
    if (!parent) {
      continue;
    }
    sessions.push(...await collectReferencedSessions(parent, visited));
  }
  return sessions;
}

async function writeBenchmarkConfig(home: string, pipeline: Pipeline, mode: ImportMode) {
  const config: Record<string, unknown> = {
    semanticIndex: {
      embedding: {
        provider: 'mock',
        dimensions: 4,
      },
      defaultImportance: 0.7,
    },
  };
  const llm: Record<string, unknown> = {};

  if (pipeline === 'generated' && (mode === 'summary' || mode === 'observation')) {
    config.turn = { llm: 'benchmark_turn_llm' };
    llm.benchmark_turn_llm = { provider: 'mock' };
  }
  if (pipeline === 'generated' && mode === 'observation') {
    config.observer = {
      name: 'benchmark-observer',
      llm: 'benchmark_observer_llm',
      maxAttempts: 3,
    };
    llm.benchmark_observer_llm = { provider: 'mock' };
  }
  if (Object.keys(llm).length > 0) {
    config.llm = llm;
  }

  const settingsPath = path.join(home, 'settings.json');
  await writeFile(settingsPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
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

function buildRows(sample: LocomoSample, pipeline: Pipeline, mode: ImportMode): SessionMessageInput[] {
  if (pipeline === 'oracle') {
    return buildOracleRows(sample, mode);
  }
  return buildGeneratedRows(sample, mode);
}

function buildOracleRows(sample: LocomoSample, mode: ImportMode): SessionMessageInput[] {
  switch (mode) {
    case 'dialog':
      return buildOracleDialogRows(sample);
    case 'observation':
      return buildOracleObservationRows(sample);
    case 'summary':
      return buildOracleSummaryRows(sample);
  }
}

function buildGeneratedRows(sample: LocomoSample, mode: ImportMode): SessionMessageInput[] {
  switch (mode) {
    case 'dialog':
      return buildGeneratedDialogRows(sample, 'dialog');
    case 'observation':
      return buildGeneratedDialogRows(sample, 'observation');
    case 'summary':
      return buildGeneratedSummaryRows(sample);
  }
}

function buildOracleDialogRows(sample: LocomoSample): SessionMessageInput[] {
  const rows: SessionMessageInput[] = [];
  for (const sessionNo of getSessionNumbers(sample.conversation)) {
    const dateTime = getDateTime(sample.conversation, sessionNo);
    const dialogs = sample.conversation[`session_${sessionNo}`] as LocomoDialog[];
    for (const dialog of dialogs) {
      const text = dialogText(dialog);
      rows.push({
        session_id: rowSessionKey(sample.sample_id, 'oracle', 'dialog', dialog.dia_id),
        agent: dialog.speaker,
        title: `LoCoMo dialog ${dialog.dia_id}`,
        summary: text,
        response: `${dateTime}\n${dialog.speaker} said "${text}"`,
        artifacts: makeArtifacts({
          sampleId: sample.sample_id,
          pipeline: 'oracle',
          mode: 'dialog',
          sourceId: dialog.dia_id,
          sessionNo,
          dateTime,
          speaker: dialog.speaker,
        }),
      });
    }
  }
  return rows;
}

function buildOracleObservationRows(sample: LocomoSample): SessionMessageInput[] {
  const rows: SessionMessageInput[] = [];
  for (const sessionNo of getSessionNumbers(sample.conversation)) {
    const dateTime = getDateTime(sample.conversation, sessionNo);
    const observations = sample.observation[`session_${sessionNo}_observation`] ?? {};
    for (const [speaker, facts] of Object.entries(observations)) {
      for (const [fact, sourceId] of facts) {
        rows.push({
          session_id: rowSessionKey(sample.sample_id, 'oracle', 'observation', sourceId),
          agent: speaker,
          title: `LoCoMo observation ${sourceId}`,
          summary: fact,
          response: `${dateTime}\nObservation by ${speaker}: ${fact}`,
          artifacts: makeArtifacts({
            sampleId: sample.sample_id,
            pipeline: 'oracle',
            mode: 'observation',
            sourceId,
            sessionNo,
            dateTime,
            speaker,
          }),
        });
      }
    }
  }
  return rows;
}

function buildOracleSummaryRows(sample: LocomoSample): SessionMessageInput[] {
  const rows: SessionMessageInput[] = [];
  for (const sessionNo of getSessionNumbers(sample.conversation)) {
    const dateTime = getDateTime(sample.conversation, sessionNo);
    const dialogs = sample.conversation[`session_${sessionNo}`] as LocomoDialog[];
    const sourceId = `S${sessionNo}`;
    const summary = sample.session_summary[`session_${sessionNo}_summary`];
    rows.push({
      session_id: rowSessionKey(sample.sample_id, 'oracle', 'summary', sourceId),
      agent: 'locomo-summary',
      title: `LoCoMo summary ${sourceId}`,
      summary,
      response: `${dateTime}\n${summary}`,
      artifacts: makeArtifacts({
        sampleId: sample.sample_id,
        pipeline: 'oracle',
        mode: 'summary',
        sourceId,
        sessionNo,
        dateTime,
        coveredDialogIds: dialogs.map((dialog) => dialog.dia_id).join(','),
      }),
    });
  }
  return rows;
}

function buildGeneratedDialogRows(
  sample: LocomoSample,
  benchmarkMode: 'dialog' | 'observation',
): SessionMessageInput[] {
  const rows: SessionMessageInput[] = [];
  for (const sessionNo of getSessionNumbers(sample.conversation)) {
    const dateTime = getDateTime(sample.conversation, sessionNo);
    const dialogs = sample.conversation[`session_${sessionNo}`] as LocomoDialog[];
    for (const dialog of dialogs) {
      const text = dialogText(dialog);
      rows.push({
        session_id: rowSessionKey(sample.sample_id, 'generated', benchmarkMode, dialog.dia_id),
        agent: dialog.speaker,
        prompt: `Date: ${dateTime}\nSpeaker: ${dialog.speaker}\nTurn id: ${dialog.dia_id}`,
        response: text,
        artifacts: makeArtifacts({
          sampleId: sample.sample_id,
          pipeline: 'generated',
          mode: benchmarkMode,
          sourceId: dialog.dia_id,
          sessionNo,
          dateTime,
          speaker: dialog.speaker,
        }),
      });
    }
  }
  return rows;
}

function buildGeneratedSummaryRows(sample: LocomoSample): SessionMessageInput[] {
  const rows: SessionMessageInput[] = [];
  for (const sessionNo of getSessionNumbers(sample.conversation)) {
    const dateTime = getDateTime(sample.conversation, sessionNo);
    const dialogs = sample.conversation[`session_${sessionNo}`] as LocomoDialog[];
    const sourceId = `S${sessionNo}`;
    rows.push({
      session_id: rowSessionKey(sample.sample_id, 'generated', 'summary', sourceId),
      agent: 'locomo-summary',
      prompt: `Summarize LoCoMo session ${sessionNo} for semantic recall.`,
      response: renderSessionTranscript(dateTime, dialogs),
      artifacts: makeArtifacts({
        sampleId: sample.sample_id,
        pipeline: 'generated',
        mode: 'summary',
        sourceId,
        sessionNo,
        dateTime,
        coveredDialogIds: dialogs.map((dialog) => dialog.dia_id).join(','),
      }),
    });
  }
  return rows;
}

function renderSessionTranscript(dateTime: string, dialogs: LocomoDialog[]): string {
  const turns = dialogs
    .map((dialog) => `${dialog.speaker}: ${dialogText(dialog)}`)
    .join('\n');
  return `Session date: ${dateTime}\n${turns}`;
}

function toBridgeHit(
  rendered: RenderedMemoryRecord,
  artifacts: ArtifactMap,
  requestedMode: ImportMode,
): BridgeHit {
  return {
    memory_id: rendered.memoryId,
    source_id: artifacts.benchmark_source_id ?? '',
    sample_id: artifacts.benchmark_sample_id ?? '',
    mode: requestedMode,
    session_no: parseInt(artifacts.benchmark_session_no ?? '0', 10),
    date_time: artifacts.benchmark_date_time ?? '',
    title: rendered.title,
    summary: rendered.summary,
    detail: rendered.detail,
  };
}

function makeArtifacts(input: {
  sampleId: string;
  pipeline: Pipeline;
  mode: ImportMode;
  sourceId: string;
  sessionNo: number;
  dateTime: string;
  speaker?: string;
  coveredDialogIds?: string;
}): ArtifactMap {
  const artifacts: ArtifactMap = {
    benchmark_name: 'locomo',
    benchmark_pipeline: input.pipeline,
    benchmark_sample_id: input.sampleId,
    benchmark_mode: input.mode,
    benchmark_source_id: input.sourceId,
    benchmark_session_no: String(input.sessionNo),
    benchmark_date_time: input.dateTime,
  };
  if (input.speaker) {
    artifacts.benchmark_speaker = input.speaker;
  }
  if (input.coveredDialogIds) {
    artifacts.benchmark_covered_dialog_ids = input.coveredDialogIds;
  }
  return artifacts;
}

function dialogText(dialog: LocomoDialog): string {
  const base = dialog.text ?? dialog.clean_text ?? dialog.compressed_text ?? '';
  if (dialog.blip_caption) {
    return `${base} [shares ${dialog.blip_caption}]`;
  }
  return base;
}

function rowSessionKey(sampleId: string, pipeline: Pipeline, mode: ImportMode, sourceId: string) {
  return `locomo:${sampleId}:${pipeline}:${mode}:${sourceId}`;
}

function getSessionNumbers(conversation: LocomoSample['conversation']): number[] {
  return Object.keys(conversation)
    .filter((key) => /^session_\d+$/.test(key))
    .map((key) => parseInt(key.split('_')[1] ?? '0', 10))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
}

function getDateTime(conversation: LocomoSample['conversation'], sessionNo: number) {
  const value = conversation[`session_${sessionNo}_date_time`];
  if (typeof value !== 'string') {
    throw new Error(`missing session_${sessionNo}_date_time`);
  }
  return value;
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

function parsePositiveInt(value: string, name: string) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${value}`);
  }
  return parsed;
}

function requireOption(options: Map<string, string>, key: string) {
  const value = options.get(key);
  if (!value) {
    throw new Error(`missing required option --${key}`);
  }
  return value;
}

function readPipelineOption(options: Map<string, string>): Pipeline {
  const raw = options.get('pipeline') ?? 'oracle';
  if (raw === 'oracle' || raw === 'generated') {
    return raw;
  }
  throw new Error(`unsupported pipeline: ${raw}`);
}

function targetLayerFor(pipeline: Pipeline, mode: ImportMode) {
  return pipeline === 'generated' && mode === 'observation' ? 'OBSERVING' : 'SESSION';
}

function memoryLayerFor(memoryId: string) {
  const [layer] = memoryId.split(':', 1);
  return layer ?? '';
}

function emitJson(payload: unknown) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

void main();
