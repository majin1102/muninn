import { Hono } from 'hono';
import type { PipelineTasksResponse } from '@muninn/common';
import { generateRequestId } from './request.js';

export const pipelineRoutes = new Hono();

pipelineRoutes.get('/app/api/pipelines', async (c) => {
  console.log('[APP_UI_PIPELINES]');

  const response: PipelineTasksResponse = {
    summary: {
      running: 0,
      queued: 0,
      failed: 0,
      updatedAt: null,
    },
    tasks: [],
    requestId: generateRequestId(),
  };

  return c.json(response);
});

