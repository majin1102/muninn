import { appendFile } from 'node:fs/promises';

import type { GatewayRoute } from './types.js';

export async function writeGatewayTrace(event: {
  observingEpoch: number;
  routes: GatewayRoute[];
}): Promise<void> {
  const file = process.env.MUNINN_OBSERVER_GATEWAY_TRACE_FILE;
  if (!file) {
    return;
  }
  const line = `${JSON.stringify({
    observingEpoch: event.observingEpoch,
    routes: event.routes.map((route) => ({
      turnId: route.turnId,
      targetThreadId: route.targetThreadId ?? null,
      newThreadTitle: route.newThreadTitle ?? null,
      sourceSlice: route.sourceSlice,
      rationale: route.rationale,
    })),
  })}\n`;
  await appendFile(file, line, 'utf8');
}
