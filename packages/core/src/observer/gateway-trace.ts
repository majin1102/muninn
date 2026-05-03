import { appendFile } from 'node:fs/promises';

import type { ThreadWorkItem } from './types.js';

export async function writeGatewayTrace(event: {
  observingEpoch: number;
  workItems: ThreadWorkItem[];
  ignoredTurnIds?: string[];
}): Promise<void> {
  const file = process.env.MUNINN_OBSERVER_GATEWAY_TRACE_FILE;
  if (!file) {
    return;
  }
  const line = `${JSON.stringify({
    observingEpoch: event.observingEpoch,
    workItems: event.workItems.map((item) => ({
      targetThreadId: item.targetThreadId ?? null,
      newThreadTitle: item.newThreadTitle ?? null,
      sourceRefs: item.sourceRefs,
      routingReason: item.routingReason,
    })),
    ignoredTurnIds: event.ignoredTurnIds ?? [],
  })}\n`;
  await appendFile(file, line, 'utf8');
}
