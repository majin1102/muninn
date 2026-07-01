import assert from 'node:assert/strict';
import test from 'node:test';

import { appStatusFromWatermark } from '../dist/http.js';

test('app status maps extractor error to error status with original message', () => {
  const response = appStatusFromWatermark({
    pending: { turns: ['turn-a'] },
    phases: { extractor: 'error' },
    error: { phase: 'extractor', message: 'empty parsed codex response' },
  }, 'req_error');

  assert.deepEqual(response, {
    status: 'error',
    extractor: {
      phase: 'error',
      pendingTurns: 1,
      error: { phase: 'extractor', message: 'empty parsed codex response' },
    },
    requestId: 'req_error',
  });
});

test('app status maps pending extractor work to warning status', () => {
  const response = appStatusFromWatermark({
    pending: { turns: ['turn-a', 'turn-b'] },
    phases: { extractor: 'running' },
  }, 'req_warning');

  assert.deepEqual(response, {
    status: 'warning',
    extractor: {
      phase: 'running',
      pendingTurns: 2,
    },
    requestId: 'req_warning',
  });
});

test('app status maps idle extractor with no pending turns to ok status', () => {
  const response = appStatusFromWatermark({
    pending: { turns: [] },
    phases: { extractor: 'idle' },
  }, 'req_ok');

  assert.deepEqual(response, {
    status: 'ok',
    extractor: {
      phase: 'idle',
      pendingTurns: 0,
    },
    requestId: 'req_ok',
  });
});
