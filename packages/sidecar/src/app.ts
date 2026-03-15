import { Hono } from 'hono';
import { memoryLoader } from './memory_loader.js';
import { memoryWriter } from './memory_writer.js';
import { generateRequestId } from './utils.js';

export const app = new Hono();

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

// 挂载写入接口
app.route('/', memoryWriter);
