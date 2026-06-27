import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import type { SettingsConfigResponse } from '@muninn/common';
import { validateSettings } from '../api/config.js';
import { resolveMuninnConfigPath } from '../config.js';
import { errorResponse, generateRequestId } from './request.js';

export const settingsRoutes = new Hono();

function defaultConfigContent(): string {
  return [
    '{',
    '  "extractor": {',
    '    "name": "default-extractor",',
    '    "llmProvider": "default",',
    '    "embeddingProvider": "default",',
    '    "recallMode": "hybrid",',
    '    "maxAttempts": 3,',
    '    "activeWindowDays": 7,',
    '    "failedEpochRetryIntervalMs": 900000',
    '  },',
    '  "providers": {',
    '    "llm": {',
    '      "default": {',
    '        "type": "mock"',
    '      }',
    '    },',
    '    "embedding": {',
    '      "default": {',
    '        "type": "mock",',
    '        "dimensions": 8',
    '      }',
    '    }',
    '  },',
    '  "watchdog": {',
    '    "enabled": true,',
    '    "intervalMs": 60000,',
    '    "compactMinFragments": 8,',
    '    "extraction": {',
    '      "targetPartitionSize": 1024,',
    '      "optimizeMergeCount": 4',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
}

settingsRoutes.get('/app/api/settings/config', async (c) => {
  const configPath = resolveMuninnConfigPath();
  let content = defaultConfigContent();

  try {
    content = await readFile(configPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      return c.json(errorResponse('internalError', 'failed to read muninn.json'), 500);
    }
  }

  let validationError: string | undefined;
  try {
    await validateSettings(content);
  } catch (error) {
    validationError = error instanceof Error ? error.message : String(error);
  }

  const response: SettingsConfigResponse = {
    pathLabel: configPath,
    content,
    validationError,
    requestId: generateRequestId(),
  };

  return c.json(response);
});

settingsRoutes.put('/app/api/settings/config', async (c) => {
  const configPath = resolveMuninnConfigPath();
  let body: { content?: string };

  try {
    body = await c.req.json<{ content?: string }>();
  } catch {
    return c.json(errorResponse('invalidRequest', 'invalid JSON body'), 400);
  }

  if (typeof body.content !== 'string') {
    return c.json(errorResponse('invalidRequest', 'content must be a string'), 400);
  }

  try {
    await validateSettings(body.content);
  } catch (error) {
    return c.json(
      errorResponse('invalidRequest', error instanceof Error ? error.message : String(error)),
      400,
    );
  }

  try {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, body.content, 'utf8');
  } catch {
    return c.json(errorResponse('internalError', 'failed to write muninn.json'), 500);
  }

  // Saving muninn.json updates the persisted config only. The current format/native
  // runtime stays alive until the process restarts, so changes do not hot-apply.

  const response: SettingsConfigResponse = {
    pathLabel: configPath,
    content: body.content,
    requestId: generateRequestId(),
  };

  return c.json(response);
});
