#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { RenderedMemoryRecord } from '@muninn/core';
import * as coreClient from '@muninn/core';

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

type ImportManifest = {
  sample_id: string;
  turns: ManifestTurn[];
};

type BridgeHit = {
  memory_id: string;
  evidence_ids: string[];
  date_time?: string;
  title?: string;
  summary?: string;
  detail?: string;
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
  process.env.MUNINN_HOME = home;
  await mkdir(home, { recursive: true });

  const sample = await loadSample(dataFile, sampleId);
  const manifestTurns: ManifestTurn[] = [];
  let importOrder = 0;

  for (const sessionNo of getSessionNumbers(sample.conversation)) {
    const dateTime = getDateTime(sample.conversation, sessionNo);
    const dialogs = sample.conversation[`session_${sessionNo}`] as LocomoDialog[];
    const sessionId = sessionKey(sample.sample_id, sessionNo);
    for (const dialog of dialogs) {
      const text = dialogLine(dialog);
      const turn = await coreClient.addMessage({
        session_id: sessionId,
        agent: dialog.speaker,
        summary: text,
        prompt: text,
        response: 'Recorded.',
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
    turns: manifestTurns,
  } satisfies ImportManifest;
  await writeManifest(home, manifest);

  return {
    sample_id: sample.sample_id,
    imported_count: manifestTurns.length,
    manifest_path: manifestPath(home),
  };
}

async function recallCommand(options: Map<string, string>) {
  const home = requireOption(options, 'muninn-home');
  process.env.MUNINN_HOME = home;
  const query = requireOption(options, 'query');
  const limit = parsePositiveInt(requireOption(options, 'limit'), 'limit');
  const manifest = await readManifest(home);
  const hits = await recallHits(query, limit, manifest);
  return { hits };
}

async function recallBatchCommand(options: Map<string, string>) {
  const home = requireOption(options, 'muninn-home');
  process.env.MUNINN_HOME = home;
  const queriesFile = requireOption(options, 'queries-file');
  const raw = await readFile(queriesFile, 'utf8');
  const queries = JSON.parse(raw) as RecallBatchQuery[];
  const manifest = await readManifest(home);
  const results: Record<string, BridgeHit[]> = {};

  for (const item of queries) {
    results[item.key] = await recallHits(item.query, item.limit, manifest);
  }

  return { results };
}

async function recallHits(
  query: string,
  limit: number,
  manifest: ImportManifest,
): Promise<BridgeHit[]> {
  const rows = await coreClient.memories.recall(query, limit);
  const turnMap = manifestTurnMap(manifest);
  const hits: BridgeHit[] = [];

  for (const row of rows) {
    const rendered = await coreClient.memories.get(row.memoryId);
    if (!rendered) {
      continue;
    }
    hits.push(await toBridgeHit(rendered, turnMap));
  }

  return hits;
}

async function toBridgeHit(
  rendered: RenderedMemoryRecord,
  turnMap: Map<string, ManifestTurn>,
): Promise<BridgeHit> {
  const evidenceIds = await resolveEvidenceIds(rendered.memoryId, turnMap);
  const dateTimes = uniquePreservingOrder(
    evidenceIds
      .map((sourceId) => findTurnBySourceId(turnMap, sourceId)?.date_time)
      .filter((value): value is string => Boolean(value)),
  );

  return {
    memory_id: rendered.memoryId,
    evidence_ids: evidenceIds,
    date_time: dateTimes.join(' | ') || undefined,
    title: rendered.title ?? undefined,
    summary: rendered.summary ?? undefined,
    detail: rendered.detail ?? undefined,
  };
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

function dialogLine(dialog: LocomoDialog): string {
  return `${dialog.speaker}: ${dialogText(dialog)}`.trim();
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

const entryArg = process.argv[1];
if (entryArg && import.meta.url === pathToFileURL(entryArg).href) {
  void main();
}
