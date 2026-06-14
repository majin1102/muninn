import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgentE2E } from '../../../scripts/e2e/agent-runner.mjs';
import { writeClaudeTranscript } from '../../../scripts/e2e/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const driverIndex = process.argv.indexOf('--driver');
const mode = process.argv.includes('--driver=real') || (driverIndex !== -1 && process.argv[driverIndex + 1] === 'real')
  ? 'real'
  : 'mock';

await runAgentE2E({
  runId: new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14),
  mode,
  agent: 'claude-code',
  shortName: 'claude',
  hookIngest: 'claude-hook',
  hookPath: path.join(repoRoot, 'claude', 'dist', 'claude-cli.js'),
  writeTranscript: writeClaudeTranscript,
  async realDriver() {
    return { status: 'skip', reason: 'real-claude-automation-unsupported' };
  },
});
