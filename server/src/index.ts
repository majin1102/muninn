#!/usr/bin/env node
import { serve } from '@hono/node-server';
import { app } from './routes.js';

export { app } from './routes.js';
export type { RecallMode } from './memory/index.js';

export type StartServerOptions = {
  host?: string;
  port?: number;
};

export function startServer(options: StartServerOptions = {}) {
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const port = options.port ?? parseInt(process.env.PORT || '8080', 10);

  console.log(`Muninn Server running on http://${host}:${port}`);

  return serve({
    fetch: app.fetch,
    hostname: host,
    port,
  });
}

if (require.main === module) {
  startServer();
}
