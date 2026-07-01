import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('app client exposes global app status endpoint with demo ok fallback', async () => {
  const source = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');

  assert.match(source, /AppStatusResponse/);
  assert.match(source, /getStatus\(\): Promise<AppStatusResponse>/);
  assert.match(source, /status: 'ok'/);
  assert.match(source, /fetchJson<AppStatusResponse>\('\/app\/api\/status'\)/);
});

test('app root renders global status banner above the shell', async () => {
  const source = await readFile(new URL('../src/components/App.tsx', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  const bannerButtonStyles = styles.slice(
    styles.indexOf('.global-status-banner-button {'),
    styles.indexOf('.global-status-banner-icon-button {'),
  );

  assert.match(source, /STATUS_POLL_INTERVAL_MS = 15_000/);
  assert.match(source, /function GlobalStatusBanner/);
  assert.match(source, /Muninn server status unavailable/);
  assert.match(source, /Extractor error:/);
  assert.match(source, /setDismissedStatusSignature/);
  assert.match(source, /appStatusSignature/);
  assert.doesNotMatch(source, /global-status-banner-meta/);
  assert.match(source, /global-status-banner-detail-row/);
  assert.equal(source.indexOf('className="app-root"') < source.indexOf('<GlobalStatusBanner'), true);
  assert.equal(source.indexOf('<GlobalStatusBanner') < source.indexOf('className="app-shell"'), true);

  assert.match(styles, /\.app-root/);
  assert.match(styles, /\.global-status-banner/);
  assert.match(styles, /\.global-status-banner-error/);
  assert.match(styles, /\.global-status-banner-warning/);
  assert.match(styles, /\.global-status-banner-detail-row/);
  assert.match(styles, /grid-template-columns: 128px minmax\(0, 1fr\)/);
  assert.match(styles, /min-height: 40px/);
  assert.doesNotMatch(bannerButtonStyles, /text-decoration/);
  assert.match(styles, /\.app-shell \{[\s\S]*flex: 1/);
  assert.doesNotMatch(styles, /\.app-shell \{[\s\S]*height: 100vh/);
});
