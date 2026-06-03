#!/usr/bin/env node

const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = '8090';
const DEFAULT_DATABASE = 'main';
const DEFAULT_INTERVAL_MS = 3000;

function usage() {
  return [
    'Usage:',
    '  node scripts/finalize-memory.mjs [options]',
    '',
    'Options:',
    '  --host <host>          Sidecar host. Default: localhost',
    '  --port <port>          Sidecar port. Default: 8090',
    '  --database <name>      Muninn database. Default: main',
    '  --interval-ms <ms>     Poll interval. Default: 3000',
    '  --max-rounds <count>   Stop after this many rounds. Default: unlimited',
    '  --help                 Show this help text',
    '',
    'Example:',
    '  node scripts/finalize-memory.mjs --port 8090 --database main',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    database: DEFAULT_DATABASE,
    intervalMs: DEFAULT_INTERVAL_MS,
    maxRounds: Number.POSITIVE_INFINITY,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--host') {
      options.host = readValue(argv, ++index, arg);
      continue;
    }
    if (arg === '--port') {
      options.port = readValue(argv, ++index, arg);
      continue;
    }
    if (arg === '--database') {
      options.database = readValue(argv, ++index, arg);
      continue;
    }
    if (arg === '--interval-ms') {
      options.intervalMs = readPositiveInteger(readValue(argv, ++index, arg), arg);
      continue;
    }
    if (arg === '--max-rounds') {
      options.maxRounds = readPositiveInteger(readValue(argv, ++index, arg), arg);
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  return options;
}

function readValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function readPositiveInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postFinalize(endpoint, database) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ database }),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`finalize failed: status=${response.status} body=${JSON.stringify(body)}`);
  }
  return body;
}

function countPending(value) {
  if (Array.isArray(value)) {
    return value.length;
  }
  if (typeof value === 'number') {
    return value;
  }
  return 0;
}

function summarize(result) {
  const pendingTurns = countPending(result?.pending?.turns);
  const pendingExtractions = countPending(result?.pending?.extractions);
  const extractor = result?.phases?.extractor ?? 'unknown';
  const observer = result?.phases?.observer ?? 'unknown';
  const watermark = result?.watermark ?? result?.baseline ?? result?.nextWatermark;
  return {
    pendingTurns,
    pendingExtractions,
    extractor,
    observer,
    watermark,
    done: pendingTurns === 0
      && pendingExtractions === 0
      && extractor === 'idle'
      && observer === 'idle',
  };
}

function formatWatermark(watermark) {
  if (!watermark || typeof watermark !== 'object') {
    return '';
  }
  const parts = Object.entries(watermark)
    .filter(([, value]) => typeof value === 'number' || typeof value === 'string')
    .map(([key, value]) => `${key}=${value}`);
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const endpoint = `http://${options.host}:${options.port}/api/v1/memory/finalize`;
  console.log(`Muninn finalize`);
  console.log(`endpoint: ${endpoint}`);
  console.log(`database: ${options.database}`);
  console.log(`interval: ${options.intervalMs}ms`);
  console.log('');

  for (let round = 1; round <= options.maxRounds; round += 1) {
    const started = Date.now();
    const result = await postFinalize(endpoint, options.database);
    const summary = summarize(result);
    const elapsed = Date.now() - started;

    console.log(
      [
        `[${new Date().toISOString()}]`,
        `round=${round}`,
        `requestMs=${elapsed}`,
        `pendingTurns=${summary.pendingTurns}`,
        `pendingExtractions=${summary.pendingExtractions}`,
        `extractor=${summary.extractor}`,
        `observer=${summary.observer}`,
        formatWatermark(summary.watermark).trim(),
      ].filter(Boolean).join(' '),
    );

    if (summary.done) {
      console.log('');
      console.log('Done: extractor and observer are idle, and no pending turns/extractions remain.');
      return;
    }

    await sleep(options.intervalMs);
  }

  throw new Error(`stopped after --max-rounds=${options.maxRounds} before finalize completed`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
