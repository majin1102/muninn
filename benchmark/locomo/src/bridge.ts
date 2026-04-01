#!/usr/bin/env node

import { mkdir, readFile, rm } from 'node:fs/promises';
import type { SessionTurnRecord } from '@munnai/core';
import * as coreClient from '@munnai/core';

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

type ArtifactMap = Record<string, string>;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);

  try {
    switch (command) {
      case 'reset-home':
        await resetHome(requireOption(options, 'munnai-home'));
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
  const home = requireOption(options, 'munnai-home');
  process.env.MUNNAI_HOME = home;
  await mkdir(home, { recursive: true });

  const sample = await loadSample(dataFile, sampleId);
  const rows = buildRows(sample, mode);
  for (const row of rows) {
    await coreClient.addMessage(row);
  }

  return {
    sample_id: sample.sample_id,
    mode,
    imported_count: rows.length,
  };
}

async function recallCommand(options: Map<string, string>) {
  process.env.MUNNAI_HOME = requireOption(options, 'munnai-home');
  const query = requireOption(options, 'query');
  const limit = parseInt(requireOption(options, 'limit'), 10);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`limit must be a positive integer, got: ${limit}`);
  }

  const rows = await coreClient.memories.recall(query, limit);
  const hits: BridgeHit[] = [];
  for (const row of rows) {
    const session = await coreClient.sessions.get(row.memoryId);
    if (!session) {
      continue;
    }
    hits.push(toBridgeHit(row, session));
  }
  return { hits };
}

async function recallBatchCommand(options: Map<string, string>) {
  process.env.MUNNAI_HOME = requireOption(options, 'munnai-home');
  const queriesFile = requireOption(options, 'queries-file');
  const raw = await readFile(queriesFile, 'utf8');
  const queries = JSON.parse(raw) as Array<{ key: string; query: string; limit: number }>;
  const results: Record<string, BridgeHit[]> = {};

  for (const item of queries) {
    const rows = await coreClient.memories.recall(item.query, item.limit);
    const hits: BridgeHit[] = [];
    for (const row of rows) {
      const session = await coreClient.sessions.get(row.memoryId);
      if (!session) {
        continue;
      }
      hits.push(toBridgeHit(row, session));
    }
    results[item.key] = hits;
  }

  return { results };
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

function buildRows(sample: LocomoSample, mode: ImportMode) {
  switch (mode) {
    case 'dialog':
      return buildDialogRows(sample);
    case 'observation':
      return buildObservationRows(sample);
    case 'summary':
      return buildSummaryRows(sample);
  }
}

function buildDialogRows(sample: LocomoSample) {
  const rows = [];
  for (const sessionNo of getSessionNumbers(sample.conversation)) {
    const dateTime = getDateTime(sample.conversation, sessionNo);
    const dialogs = sample.conversation[`session_${sessionNo}`] as LocomoDialog[];
    for (const dialog of dialogs) {
      const text = dialogText(dialog);
      rows.push({
        session_id: sessionKey(sample.sample_id, 'dialog', sessionNo),
        agent: dialog.speaker,
        title: `LOCOMO dialog ${dialog.dia_id}`,
        summary: text,
        response: `${dateTime}\n${dialog.speaker} said "${text}"`,
        artifacts: makeArtifacts({
          sampleId: sample.sample_id,
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

function buildObservationRows(sample: LocomoSample) {
  const rows = [];
  for (const sessionNo of getSessionNumbers(sample.conversation)) {
    const dateTime = getDateTime(sample.conversation, sessionNo);
    const observations = sample.observation[`session_${sessionNo}_observation`] ?? {};
    for (const [speaker, facts] of Object.entries(observations)) {
      for (const [fact, sourceId] of facts) {
        rows.push({
          session_id: sessionKey(sample.sample_id, 'observation', sessionNo),
          agent: speaker,
          title: `LOCOMO observation ${sourceId}`,
          summary: fact,
          response: `${dateTime}\nObservation by ${speaker}: ${fact}`,
          artifacts: makeArtifacts({
            sampleId: sample.sample_id,
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

function buildSummaryRows(sample: LocomoSample) {
  const rows = [];
  for (const sessionNo of getSessionNumbers(sample.conversation)) {
    const dateTime = getDateTime(sample.conversation, sessionNo);
    const sourceId = `S${sessionNo}`;
    const summary = sample.session_summary[`session_${sessionNo}_summary`];
    const coveredDialogIds = (sample.conversation[`session_${sessionNo}`] as LocomoDialog[])
      .map((dialog) => dialog.dia_id)
      .join(',');
    rows.push({
      session_id: sessionKey(sample.sample_id, 'summary', sessionNo),
      agent: 'locomo-summary',
      title: `LOCOMO summary ${sourceId}`,
      summary,
      response: `${dateTime}\n${summary}`,
      artifacts: makeArtifacts({
        sampleId: sample.sample_id,
        mode: 'summary',
        sourceId,
        sessionNo,
        dateTime,
        coveredDialogIds,
      }),
    });
  }
  return rows;
}

function toBridgeHit(
  row: { memoryId: string; title?: string; summary?: string; detail?: string },
  session: SessionTurnRecord,
): BridgeHit {
  const artifacts = session.artifacts ?? {};
  return {
    memory_id: row.memoryId,
    source_id: artifacts.benchmark_source_id ?? '',
    sample_id: artifacts.benchmark_sample_id ?? '',
    mode: artifacts.benchmark_mode ?? '',
    session_no: parseInt(artifacts.benchmark_session_no ?? '0', 10),
    date_time: artifacts.benchmark_date_time ?? '',
    title: row.title,
    summary: row.summary,
    detail: row.detail,
  };
}

function makeArtifacts(input: {
  sampleId: string;
  mode: ImportMode;
  sourceId: string;
  sessionNo: number;
  dateTime: string;
  speaker?: string;
  coveredDialogIds?: string;
}): ArtifactMap {
  const artifacts: ArtifactMap = {
    benchmark_name: 'locomo',
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

function sessionKey(sampleId: string, mode: ImportMode, sessionNo: number) {
  return `locomo:${sampleId}:${mode}:session_${sessionNo}`;
}

function getSessionNumbers(conversation: LocomoSample['conversation']): number[] {
  const numbers = Object.keys(conversation)
    .filter((key) => /^session_\d+$/.test(key))
    .map((key) => parseInt(key.split('_')[1] ?? '0', 10))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  return numbers;
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

void main();
