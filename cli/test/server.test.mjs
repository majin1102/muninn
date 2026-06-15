import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { resolveServerProcessPaths } from '../dist/server.js';

test('resolveServerProcessPaths keeps CLI-managed state under Muninn home', () => {
  const paths = resolveServerProcessPaths('/tmp/muninn-home');
  assert.deepEqual(paths, {
    runDir: path.join('/tmp/muninn-home', 'run'),
    stateFile: path.join('/tmp/muninn-home', 'run', 'server.json'),
    stdoutLog: path.join('/tmp/muninn-home', 'run', 'server.stdout.log'),
    stderrLog: path.join('/tmp/muninn-home', 'run', 'server.stderr.log'),
  });
});
