import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { errorResponse } from './request.js';

export const assetRoutes = new Hono();

const packageRoot = path.resolve(__dirname, '..', '..', '..');

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function resolveArtifactStorePath(): string {
  const home = process.env.MUNINN_HOME ?? path.join(os.homedir(), '.muninn');
  return path.join(home, 'default', 'artifacts');
}

function resolveWebDistPath(): string {
  const candidates = [
    process.env.MUNINN_WEB_DIST,
    path.join(packageRoot, 'web', 'dist'),
    path.resolve(process.cwd(), '..', 'web', 'dist'),
    path.resolve(process.cwd(), 'web', 'dist'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

function getWebAssetPath(relativePath: string): string {
  const normalized = path.posix.normalize(`/${relativePath}`).replace(/^\/+/, '');
  return path.join(resolveWebDistPath(), normalized);
}

function contentTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream';
}

async function serveWebFile(filePath: string): Promise<Response> {
  try {
    const content = await readFile(filePath);
    return new Response(content, {
      headers: {
        'content-type': contentTypeFor(filePath),
        'cache-control': 'no-store',
      },
    });
  } catch {
    return new Response('Not Found', { status: 404 });
  }
}

assetRoutes.get('/app', (c) => c.redirect('/app/'));

assetRoutes.get('/app/', async () => {
  return serveWebFile(getWebAssetPath('index.html'));
});

assetRoutes.get('/app/artifacts/*', async (c) => {
  const name = safeDecodeURIComponent(c.req.path.slice('/app/artifacts/'.length));
  if (!isSafeArtifactPath(name)) {
    return c.json(errorResponse('invalidRequest', 'invalid artifact path'), 400);
  }

  const store = resolveArtifactStorePath();
  const filePath = path.join(store, name);
  const resolvedStore = path.resolve(store);
  const resolvedFile = path.resolve(filePath);
  if (!resolvedFile.startsWith(`${resolvedStore}${path.sep}`)) {
    return c.json(errorResponse('invalidRequest', 'invalid artifact path'), 400);
  }

  try {
    await stat(resolvedFile);
    return serveWebFile(resolvedFile);
  } catch {
    return c.json(errorResponse('notFound', 'artifact not found'), 404);
  }
});

assetRoutes.get('/app/:asset{.+}', async (c) => {
  const asset = c.req.param('asset');
  if (asset.includes('..')) {
    return c.text('Not Found', 404);
  }
  return serveWebFile(getWebAssetPath(asset));
});

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isSafeArtifactPath(value: string | null): value is string {
  if (!value || path.isAbsolute(value) || value.includes('\0')) {
    return false;
  }
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    return false;
  }
  return parts.every((part) => /^[a-z0-9._-]+$/i.test(part));
}
