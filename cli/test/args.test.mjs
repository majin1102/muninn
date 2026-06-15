import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from '../dist/args.js';

test('parseArgs parses run defaults and flags', () => {
  assert.deepEqual(parseArgs(['run']), {
    command: 'run',
    host: undefined,
    port: undefined,
    home: undefined,
  });
  assert.deepEqual(parseArgs(['run', '--host', '127.0.0.1', '--port', '8081', '--home', '/tmp/muninn']), {
    command: 'run',
    host: '127.0.0.1',
    port: 8081,
    home: '/tmp/muninn',
  });
});

test('parseArgs parses process commands', () => {
  assert.deepEqual(parseArgs(['start', '--host', '0.0.0.0', '--port', '8082', '--home', '/tmp/muninn', '--force']), {
    command: 'start',
    host: '0.0.0.0',
    port: 8082,
    home: '/tmp/muninn',
    force: true,
  });
  assert.deepEqual(parseArgs(['restart', '--force']), {
    command: 'restart',
    host: undefined,
    port: undefined,
    home: undefined,
    force: true,
  });
  assert.deepEqual(parseArgs(['stop', '--home', '/tmp/muninn', '--force']), {
    command: 'stop',
    home: '/tmp/muninn',
    force: true,
  });
});

test('parseArgs parses install target and common flags', () => {
  assert.deepEqual(parseArgs([
    'install',
    'codex',
    '--mcp-only',
    '--scope',
    'project',
    '--server-url',
    'http://127.0.0.1:8081',
    '--dry-run',
  ]), {
    command: 'install',
    target: 'codex',
    mcpOnly: true,
    hookOnly: false,
    scope: 'project',
    serverUrl: 'http://127.0.0.1:8081',
    dryRun: true,
    yes: false,
  });
});

test('parseArgs rejects mcp as install target', () => {
  assert.throws(
    () => parseArgs(['install', 'mcp']),
    /install target must be one of: codex, claude, all/,
  );
});

test('parseArgs rejects conflicting install part flags', () => {
  assert.throws(
    () => parseArgs(['install', 'all', '--mcp-only', '--hook-only']),
    /--mcp-only and --hook-only cannot be used together/,
  );
});

test('parseArgs rejects unknown run flags', () => {
  assert.throws(
    () => parseArgs(['run', '--porrt', '8081']),
    /unknown flag: --porrt/,
  );
});

test('parseArgs rejects valued force flags', () => {
  assert.throws(
    () => parseArgs(['start', '--force', 'true']),
    /--force does not accept a value/,
  );
});

test('parseArgs rejects unknown install flags', () => {
  assert.throws(
    () => parseArgs(['install', 'codex', '--bad']),
    /unknown flag: --bad/,
  );
});

test('parseArgs rejects ports outside TCP range', () => {
  assert.throws(
    () => parseArgs(['run', '--port', '70000']),
    /--port must be an integer from 1 to 65535/,
  );
});
