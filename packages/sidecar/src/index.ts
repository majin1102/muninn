import { serve } from '@hono/node-server';
import { app } from './app.js';

export { app } from './app.js';

if (require.main === module) {
  const port = parseInt(process.env.PORT || '8080', 10);

  console.log(`Muninn Sidecar running on http://localhost:${port}`);

  serve({
    fetch: app.fetch,
    port,
  });
}
