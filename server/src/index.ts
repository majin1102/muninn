import { serve } from '@hono/node-server';
import { app } from './app.js';

export { app } from './app.js';

if (require.main === module) {
  const host = process.env.HOST || '127.0.0.1';
  const port = parseInt(process.env.PORT || '8080', 10);

  console.log(`Muninn Server running on http://${host}:${port}`);

  serve({
    fetch: app.fetch,
    hostname: host,
    port,
  });
}
