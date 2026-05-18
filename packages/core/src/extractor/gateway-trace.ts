import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { SessionFragment } from './types.js';

export async function writeGatewayTrace(event: {
  observingEpoch: number;
  durationMs?: number;
  sessionFragments: SessionFragment[];
}): Promise<void> {
  const file = process.env.MUNINN_OBSERVER_GATEWAY_TRACE_FILE;
  if (!file) {
    return;
  }
  await mkdir(path.dirname(file), { recursive: true });
  const line = `${JSON.stringify({
    observingEpoch: event.observingEpoch,
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    sessionFragments: event.sessionFragments.map((fragment) => ({
      threadId: fragment.threadId,
      turnIds: fragment.turnIds,
      content: fragment.content,
      reason: fragment.reason,
    })),
  })}\n`;
  await appendFile(file, line, 'utf8');
}
