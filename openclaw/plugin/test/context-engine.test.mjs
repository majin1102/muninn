import test from "node:test";
import assert from "node:assert/strict";

import { createMunnaiContextEngine } from "../dist/src/context-engine.js";

test("assemble returns original messages when recall fails", async () => {
  const warnings = [];
  const engine = createMunnaiContextEngine({
    config: { baseUrl: "http://localhost:3100", enabled: true, timeoutMs: 100, recencyLimit: 5 },
    logger: { warn: (msg) => warnings.push(msg) },
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => "" }),
  });

  const result = await engine.assemble({
    sessionId: "test",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.strictEqual(result.messages.length, 1);
  assert.strictEqual(result.systemPromptAddition, undefined);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /munnai recall failed: 500/);
});

test("assemble injects memories when recall succeeds", async () => {
  const engine = createMunnaiContextEngine({
    config: { baseUrl: "http://localhost:3100", enabled: true, timeoutMs: 1000, recencyLimit: 5 },
    logger: {},
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        memoryHits: [{ content: "Memory 1" }, { content: "Memory 2" }],
      }),
    }),
  });

  const result = await engine.assemble({
    sessionId: "test",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.ok(result.systemPromptAddition?.includes("<relevant-memories>"));
  assert.ok(result.systemPromptAddition?.includes("Memory 1"));
  assert.ok(result.systemPromptAddition?.includes("Memory 2"));
});

test("assemble returns no systemPromptAddition when memories are empty", async () => {
  const engine = createMunnaiContextEngine({
    config: { baseUrl: "http://localhost:3100", enabled: true, timeoutMs: 1000, recencyLimit: 5 },
    logger: {},
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ memoryHits: [] }),
    }),
  });

  const result = await engine.assemble({
    sessionId: "test",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.strictEqual(result.systemPromptAddition, undefined);
});

test("assemble degrades gracefully on fetch exception", async () => {
  const warnings = [];
  const engine = createMunnaiContextEngine({
    config: { baseUrl: "http://localhost:3100", enabled: true, timeoutMs: 100, recencyLimit: 5 },
    logger: { warn: (msg) => warnings.push(msg) },
    fetchImpl: async () => { throw new Error("network error"); },
  });

  const result = await engine.assemble({
    sessionId: "test",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.strictEqual(result.messages.length, 1);
  assert.strictEqual(result.systemPromptAddition, undefined);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /munnai assemble failed/);
});

test("assemble uses configured recencyLimit in the request URL", async () => {
  const calls = [];
  const engine = createMunnaiContextEngine({
    config: { baseUrl: "http://localhost:3100", enabled: true, timeoutMs: 1000, recencyLimit: 7 },
    logger: {},
    fetchImpl: async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ memoryHits: [] }),
      };
    },
  });

  await engine.assemble({
    sessionId: "test",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.strictEqual(calls.length, 1);
  assert.match(calls[0], /limit=7/);
});

test("context engine does not implement afterTurn writes", () => {
  const engine = createMunnaiContextEngine({
    config: { baseUrl: "http://localhost:3100", enabled: true, timeoutMs: 1000, recencyLimit: 5 },
    logger: {},
  });

  assert.strictEqual(engine.afterTurn, undefined);
});
