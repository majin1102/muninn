import assert from 'node:assert/strict';
import test from 'node:test';

import { buildStartupRecent } from '../dist/startup-context.js';

test('buildStartupRecent returns five sessions and independent recent/project signal budgets', async () => {
  const snapshots = Array.from({ length: 6 }, (_, index) => snapshot(index));
  snapshots[5].memorySignals = Array.from({ length: 8 }, (_, index) => (
    signal(`turn:instruction-${index}`, `recent instruction ${index}`)
  ));
  snapshots[5].skillSignals = Array.from({ length: 4 }, (_, index) => (
    signal(`turn:skill-${index}`, `skill-${index}: recent skill ${index}`)
  ));
  const turnRows = new Map();
  for (let index = 0; index < 8; index += 1) {
    turnRows.set(`turn:instruction-${index}`, turn(`turn:instruction-${index}`, index));
  }
  for (let index = 0; index < 4; index += 1) {
    turnRows.set(`turn:skill-${index}`, turn(`turn:skill-${index}`, index));
  }
  const projectSignals = {
    project: 'github.com/majin1102/muninn',
    memorySignals: [
      projectInstruction('recent instruction 7', 100),
      ...Array.from({ length: 20 }, (_, index) => projectInstruction(`project instruction ${index}`, 99 - index)),
    ],
    skillSignals: [
      projectSkill('skill-3', 'duplicate recent skill', 100),
      ...Array.from({ length: 10 }, (_, index) => projectSkill(`project-skill-${index}`, `project skill ${index}`, 99 - index)),
    ],
  };
  const deps = {
    async listSessionIndex() {
      return snapshots.map((row) => ({
        project: row.project,
        latestUpdatedAt: row.updatedAt,
        snapshotId: row.snapshotId,
      }));
    },
    async getSession(snapshotId) {
      return snapshots.find((row) => row.snapshotId === snapshotId) ?? null;
    },
    async getTurn(turnId) {
      return turnRows.get(turnId) ?? null;
    },
    async getProjectSignals(_project, limit) {
      assert.equal(limit, 27);
      return projectSignals;
    },
  };

  const result = await buildStartupRecent('github.com/majin1102/muninn', deps);

  assert.equal(result.recentSessions.length, 5);
  assert.deepEqual(result.recentSessions[0], {
    contextId: 'session_snapshot-5',
    title: 'Session 5',
    summary: 'Summary 5',
  });
  assert.equal(result.instructionSignals.length, 20);
  assert.deepEqual(result.instructionSignals.slice(0, 7), [
    'recent instruction 7',
    'recent instruction 6',
    'recent instruction 5',
    'recent instruction 4',
    'recent instruction 3',
    'recent instruction 2',
    'recent instruction 1',
  ]);
  assert.equal(result.instructionSignals.filter((value) => value === 'recent instruction 7').length, 1);
  assert.equal(result.skills.length, 10);
  assert.deepEqual(result.skills.slice(0, 3), [
    { name: 'skill-3', summary: 'recent skill 3' },
    { name: 'skill-2', summary: 'recent skill 2' },
    { name: 'skill-1', summary: 'recent skill 1' },
  ]);
  assert.equal(result.skills.filter((value) => value.name === 'skill-3').length, 1);
});

test('buildStartupRecent excludes malformed sessions and signals without supporting turns', async () => {
  const valid = snapshot(1);
  valid.memorySignals = [signal('turn:missing', 'unsupported')];
  const invalid = { ...snapshot(2), title: '' };
  const deps = {
    async listSessionIndex() {
      return [invalid, valid].map((row) => ({
        project: row.project,
        latestUpdatedAt: row.updatedAt,
        snapshotId: row.snapshotId,
      }));
    },
    async getSession(snapshotId) {
      return [invalid, valid].find((row) => row.snapshotId === snapshotId) ?? null;
    },
    async getTurn() {
      return null;
    },
    async getProjectSignals() {
      return null;
    },
  };

  const result = await buildStartupRecent(valid.project, deps);

  assert.equal(result.recentSessions.length, 1);
  assert.deepEqual(result.instructionSignals, []);
  assert.deepEqual(result.skills, []);
});

test('buildStartupRecent ranks sessions by snapshot update time instead of stale index time', async () => {
  const snapshots = Array.from({ length: 6 }, (_, index) => snapshot(index));
  const deps = {
    async listSessionIndex() {
      return snapshots.map((row, index) => ({
        project: row.project,
        latestUpdatedAt: `2026-08-${String(6 - index).padStart(2, '0')}T00:00:00.000Z`,
        snapshotId: row.snapshotId,
      }));
    },
    async getSession(snapshotId) {
      return snapshots.find((row) => row.snapshotId === snapshotId) ?? null;
    },
    async getTurn() {
      return null;
    },
    async getProjectSignals() {
      return null;
    },
  };

  const result = await buildStartupRecent(snapshots[0].project, deps);

  assert.deepEqual(
    result.recentSessions.map((session) => session.contextId),
    ['session_snapshot-5', 'session_snapshot-4', 'session_snapshot-3', 'session_snapshot-2', 'session_snapshot-1'],
  );
});

test('buildStartupRecent normalizes multiline instruction and skill signals', async () => {
  const current = snapshot(1);
  current.memorySignals = [signal('turn:multi-instruction', 'first line\n  second line')];
  current.skillSignals = [signal('turn:multi-skill', 'multiline-skill: first line\n  second line')];
  const turnRows = new Map([
    ['turn:multi-instruction', turn('turn:multi-instruction', 1)],
    ['turn:multi-skill', turn('turn:multi-skill', 2)],
  ]);
  const deps = {
    async listSessionIndex() {
      return [{
        project: current.project,
        latestUpdatedAt: current.updatedAt,
        snapshotId: current.snapshotId,
      }];
    },
    async getSession() {
      return current;
    },
    async getTurn(turnId) {
      return turnRows.get(turnId) ?? null;
    },
    async getProjectSignals() {
      return null;
    },
  };

  const result = await buildStartupRecent(current.project, deps);

  assert.deepEqual(result.instructionSignals, ['first line second line']);
  assert.deepEqual(result.skills, [{ name: 'multiline-skill', summary: 'first line second line' }]);
});

function snapshot(index) {
  const timestamp = `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`;
  return {
    snapshotId: `session:snapshot-${index}`,
    sessionId: `session-${index}`,
    project: 'github.com/majin1102/muninn',
    cwd: '/repo/muninn',
    agent: 'codex',
    snapshotSequence: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    extractor: 'extractor',
    title: `Session ${index}`,
    summary: `Summary ${index}`,
    memorySignals: [],
    skillSignals: [],
    skillDetails: '{}',
    content: '',
    references: [],
  };
}

function signal(turnId, body) {
  return `- [${turnId} +1] ${body}`;
}

function turn(turnId, minute) {
  const timestamp = `2026-07-10T00:${String(minute).padStart(2, '0')}:00.000Z`;
  return {
    turnId,
    createdAt: timestamp,
    updatedAt: timestamp,
    project: 'github.com/majin1102/muninn',
    cwd: '/repo/muninn',
    agent: 'codex',
    extractor: 'extractor',
    events: [],
  };
}

function projectInstruction(text, score) {
  return { score, text, updatedAt: null, supportTurns: [] };
}

function projectSkill(name, summary, score) {
  return { score, name, summary, detail: summary };
}
