import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadProjectDisplay() {
  const source = await readFile(new URL('../src/lib/project_display.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

test('projectDisplayLabels uses basename for unique project paths', async () => {
  const { projectDisplayLabels } = await loadProjectDisplay();

  assert.deepEqual(Object.fromEntries(projectDisplayLabels([
    '/Users/Nathan/workspace/muninn',
    '/Users/Nathan/workspace/openclaw',
  ])), {
    '/Users/Nathan/workspace/muninn': 'muninn',
    '/Users/Nathan/workspace/openclaw': 'openclaw',
  });
});

test('projectDisplayLabel displays GitHub project identities as owner and repo', async () => {
  const { projectDisplayLabel, projectDisplayLabels } = await loadProjectDisplay();

  assert.equal(projectDisplayLabel('github.com/lance-format/lance'), 'lance-format/lance');
  assert.deepEqual(Object.fromEntries(projectDisplayLabels([
    'github.com/lance-format/lance',
    '/Users/Nathan/workspace/muninn',
  ])), {
    'github.com/lance-format/lance': 'lance-format/lance',
    '/Users/Nathan/workspace/muninn': 'muninn',
  });
});

test('projectDisplayLabels expands duplicate basenames to the shortest unique right suffix', async () => {
  const { projectDisplayLabels } = await loadProjectDisplay();

  assert.deepEqual(Object.fromEntries(projectDisplayLabels([
    '/Users/Nathan/workspace/openclaw',
    '/Users/Nathan/.codex/worktrees/02a9/openclaw',
    '/Users/Nathan/.codex/worktrees/034d/openclaw',
    '/Users/Nathan/workspace/memory-ultra',
    '/Users/Nathan/.codex/worktrees/043d/memory-ultra',
  ])), {
    '/Users/Nathan/workspace/openclaw': 'workspace/openclaw',
    '/Users/Nathan/.codex/worktrees/02a9/openclaw': '02a9/openclaw',
    '/Users/Nathan/.codex/worktrees/034d/openclaw': '034d/openclaw',
    '/Users/Nathan/workspace/memory-ultra': 'workspace/memory-ultra',
    '/Users/Nathan/.codex/worktrees/043d/memory-ultra': '043d/memory-ultra',
  });
});

test('projectDisplayLabels handles roots, relative names, trailing slashes, and repeated paths', async () => {
  const { projectDisplayLabel, projectDisplayLabels } = await loadProjectDisplay();

  assert.equal(projectDisplayLabel('/Users/Nathan/workspace/muninn/'), 'muninn');
  assert.equal(projectDisplayLabel('muninn'), 'muninn');
  assert.equal(projectDisplayLabel('/'), '/');

  assert.deepEqual([...projectDisplayLabels([
    '/Users/Nathan/workspace/muninn/',
    '/Users/Nathan/workspace/muninn/',
  ])], [['/Users/Nathan/workspace/muninn/', 'muninn']]);
});
