import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { appRoutes } from './ui/app.js';
import { memoryLoader } from './memory_loader.js';
import { memoryWriter } from './memory_writer.js';
import { generateRequestId } from './utils.js';

export const app = new Hono();

const BOARD_CORS_ORIGINS = [
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

app.use('/api/*', cors({
  origin: BOARD_CORS_ORIGINS,
}));
app.use('/version', cors({
  origin: BOARD_CORS_ORIGINS,
}));
app.use('/health', cors({
  origin: BOARD_CORS_ORIGINS,
}));

app.use('/api/*', async (c, next) => {
  const token = process.env.MUNINN_DESKTOP_TOKEN;
  if (!token) {
    await next();
    return;
  }

  if (c.req.header('authorization') !== `Bearer ${token}`) {
    return c.json({
      errorCode: 'unauthorized',
      errorMessage: 'desktop authorization token is required',
      requestId: generateRequestId(),
    }, 401);
  }

  await next();
});

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    version: '0.1.0',
    datasetPath: '/data',
    requestId: generateRequestId(),
  });
});

app.get('/version', (c) => {
  return c.json({
    version: '0.1.0',
    capabilities: {
      vectorSearch: true,
      fullTextSearch: true,
      merge: true,
    },
    requestId: generateRequestId(),
  });
});

app.route('/', memoryLoader);

app.route('/', appRoutes);

app.route('/', memoryWriter);
