import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadTypes() {
  const identitySource = await readFile(new URL('../src/session-identity.ts', import.meta.url), 'utf8');
  const source = identitySource;
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

test('sessionIdentityKey uses project agent and session id only', async () => {
  const { sessionIdentityKey } = await loadTypes();

  assert.equal(
    sessionIdentityKey({ project: '/workspace/muninn', agent: 'codex', sessionId: 'same-session' }),
    '/workspace/muninn\u001fcodex\u001fsame-session',
  );
});

test('sessionIdentityKey changes when project agent or session id changes', async () => {
  const { sessionIdentityKey } = await loadTypes();
  const base = sessionIdentityKey({ project: '/workspace/muninn', agent: 'codex', sessionId: 'same-session' });

  assert.notEqual(base, sessionIdentityKey({ project: '/workspace/lance', agent: 'codex', sessionId: 'same-session' }));
  assert.notEqual(base, sessionIdentityKey({ project: '/workspace/muninn', agent: 'claude-code', sessionId: 'same-session' }));
  assert.notEqual(base, sessionIdentityKey({ project: '/workspace/muninn', agent: 'codex', sessionId: 'other-session' }));
});

test('sessionIdentityKeyMatches validates encoded keys without exposing parsing', async () => {
  const { sessionIdentityKeyMatches, sessionIdentityKey } = await loadTypes();
  const identity = { project: '/workspace/muninn', agent: 'codex', sessionId: 'same-session' };

  assert.equal(sessionIdentityKeyMatches(sessionIdentityKey(identity), identity), true);
  assert.equal(sessionIdentityKeyMatches(sessionIdentityKey(identity), { ...identity, agent: 'claude-code' }), false);
  assert.equal(sessionIdentityKeyMatches('/workspace/muninn\u001fcodex', identity), false);
  assert.equal(sessionIdentityKeyMatches('/workspace/muninn\u001f\u001fsame-session', identity), false);
});
