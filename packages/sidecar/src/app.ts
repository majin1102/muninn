import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { boardApp } from '@munnai/board/server';
import { memoryLoader } from './memory_loader.js';
import { memoryWriter } from './memory_writer.js';
import { generateRequestId } from './utils.js';

export const app = new Hono();

app.use('/api/*', cors({
  origin: ['http://localhost:4173', 'http://127.0.0.1:4173'],
}));
app.use('/version', cors({
  origin: ['http://localhost:4173', 'http://127.0.0.1:4173'],
}));
app.use('/health', cors({
  origin: ['http://localhost:4173', 'http://127.0.0.1:4173'],
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

// 挂载 Munnai Board（页面与人类向 UI 接口）
app.route('/', boardApp);

// 挂载写入接口
app.route('/', memoryWriter);
