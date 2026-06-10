import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadArtifactView() {
  const source = await readFile(new URL('../src/lib/artifacts.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

test('artifactPresentation renders images and markdown inline but opens html separately', async () => {
  const { artifactPresentation } = await loadArtifactView();

  assert.equal(artifactPresentation({
    key: 'img',
    kind: 'image',
    source: 'tool',
    uri: 'artifact://sessions/codex-demo/render.svg',
    name: 'render.svg',
  }).mode, 'image');

  assert.deepEqual(artifactPresentation({
    key: 'md',
    kind: 'file',
    source: 'response',
    uri: 'artifact://sessions/codex-demo/research.md',
    name: 'research.md',
    mimeType: 'text/plain',
    content: '# Research\n\nDetails',
  }), {
    href: '/api/v1/artifacts/sessions%2Fcodex-demo%2Fresearch.md',
    icon: 'document',
    label: 'research.md',
    meta: 'text/plain',
    mode: 'markdown',
    text: '# Research\n\nDetails',
  });

  assert.equal(artifactPresentation({
    key: 'html',
    kind: 'file',
    source: 'response',
    uri: 'artifact://sessions/codex-demo/report.html',
    name: 'report.html',
    mimeType: 'text/html',
    content: '<h1>Report</h1>',
  }).mode, 'external');
});
