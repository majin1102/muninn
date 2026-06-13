import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { boardApp } from '@muninn/board/server';
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

// 健康检查
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    version: '0.1.0',
    datasetPath: '/data',
    requestId: generateRequestId(),
  });
});

// 版本信息
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

// 挂载读取接口
app.route('/', memoryLoader);

// 挂载 Muninn Board（页面与人类向 UI 接口）
app.route('/', boardApp);

// 挂载写入接口
app.route('/', memoryWriter);
