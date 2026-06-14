import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { waitFor } from './http.mjs';

export async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export async function startMuninnServer({ repoRoot, home, env = {} }) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(repoRoot, 'server', 'dist', 'index.js')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
      HOST: '127.0.0.1',
      PORT: String(port),
      MUNINN_HOME: home,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  await waitFor(async () => {
    const response = await fetch(`${baseUrl}/health`).catch(() => null);
    return response?.ok;
  }, { timeoutMs: 10000, intervalMs: 100, label: 'Muninn server health' });

  return {
    baseUrl,
    child,
    output: () => ({ stdout, stderr }),
    async stop() {
      if (child.exitCode !== null) {
        return;
      }
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}
