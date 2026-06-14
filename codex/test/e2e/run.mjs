import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgentE2E } from '../../../scripts/e2e/agent-runner.mjs';
import { writeCodexTranscript } from '../../../scripts/e2e/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const driverIndex = process.argv.indexOf('--driver');
const mode = process.argv.includes('--driver=real') || (driverIndex !== -1 && process.argv[driverIndex + 1] === 'real')
  ? 'real'
  : 'mock';

await runAgentE2E({
  runId: new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14),
  mode,
  agent: 'codex',
  shortName: 'codex',
  hookIngest: 'codex-hook',
  hookPath: path.join(repoRoot, 'codex', 'dist', 'cli.js'),
  writeTranscript: writeCodexTranscript,
  async realDriver() {
    if (!process.env.MUNINN_E2E_CODEX_REAL_COMMAND) {
      return { status: 'skip', reason: 'set-MUNINN_E2E_CODEX_REAL_COMMAND-to-run-real-codex' };
    }
    return { status: 'skip', reason: 'real-codex-command-execution-requires-runner-integration' };
  },
});
