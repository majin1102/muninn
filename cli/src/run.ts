import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

export type RunOptions = {
  host?: string;
  port?: number;
  home?: string;
};

type ServerModule = {
  startServer(options: { host?: string; port?: number }): unknown;
};

const require = createRequire(import.meta.url);

export function resolveRunEnv(options: RunOptions): Record<'HOST' | 'PORT' | 'MUNINN_HOME', string> {
  return {
    HOST: options.host ?? '127.0.0.1',
    PORT: String(options.port ?? 8080),
    MUNINN_HOME: options.home ?? path.join(os.homedir(), '.muninn'),
  };
}

export async function runServer(options: RunOptions): Promise<void> {
  const env = resolveRunEnv(options);
  process.env.HOST = env.HOST;
  process.env.PORT = env.PORT;
  process.env.MUNINN_HOME = env.MUNINN_HOME;

  process.stdout.write(`Muninn server running: http://${env.HOST}:${env.PORT}\n`);
  process.stdout.write(`Data home: ${env.MUNINN_HOME}\n`);
  process.stdout.write(`Health: http://${env.HOST}:${env.PORT}/health\n`);

  const serverModule = require('@muninn/server') as ServerModule;
  serverModule.startServer({
    host: env.HOST,
    port: Number(env.PORT),
  });
}
