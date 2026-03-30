import test from "node:test";
import assert from "node:assert/strict";

import { createMunnaiContextEngine } from "../dist/src/context-engine.js";

test("assemble returns original messages when recall fails", async () => {
  const warnings = [];
  const engine = createMunnaiContextEngine({
    config: { baseUrl: "http://localhost:3100", enabled: true, timeoutMs: 100 },
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
    config: { baseUrl: "http://localhost:3100", enabled: true, timeoutMs: 1000 },
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
    config: { baseUrl: "http://localhost:3100", enabled: true, timeoutMs: 1000 },
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
    config: { baseUrl: "http://localhost:3100", enabled: true, timeoutMs: 100 },
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

test("afterTurn extracts and writes user/assistant texts", async () => {
  const calls = [];
  const engine = createMunnaiContextEngine({
    config: { baseUrl: "http://localhost:3100", enabled: true, timeoutMs: 1000 },
    logger: {},
    fetchImpl: async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 200 };
    },
  });

  await engine.afterTurn({
    sessionId: "test-session",
    sessionFile: "/tmp/session.json",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ],
    prePromptMessageCount: 0,
  });

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].body.session.session_id, "test-session");
  assert.strictEqual(calls[0].body.session.prompt, "hello");
  assert.strictEqual(calls[0].body.session.response, "hi there");
});

test("afterTurn skips write when no new messages", async () => {
  const calls = [];
  const engine = createMunnaiContextEngine({
    config: { baseUrl: "http://localhost:3100", enabled: true, timeoutMs: 1000 },
    logger: {},
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200 };
    },
  });

  await engine.afterTurn({
    sessionId: "test-session",
    sessionFile: "/tmp/session.json",
    messages: [{ role: "user", content: "hello" }],
    prePromptMessageCount: 1,
  });

  assert.strictEqual(calls.length, 0);
});

test("afterTurn degrades gracefully on write failure", async () => {
  const warnings = [];
  const engine = createMunnaiContextEngine({
    config: { baseUrl: "http://localhost:3100", enabled: true, timeoutMs: 100 },
    logger: { warn: (msg) => warnings.push(msg) },
    fetchImpl: async () => { throw new Error("write failed"); },
  });

  await engine.afterTurn({
    sessionId: "test-session",
    sessionFile: "/tmp/session.json",
    messages: [{ role: "user", content: "hello" }],
    prePromptMessageCount: 0,
  });

  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /munnai afterTurn failed/);
});

test("afterTurn extracts text from array content", async () => {
  const calls = [];
  const engine = createMunnaiContextEngine({
    config: { baseUrl: "http://localhost:3100", enabled: true, timeoutMs: 1000 },
    logger: {},
    fetchImpl: async (url, opts) => {
      calls.push({ body: JSON.parse(opts.body) });
      return { ok: true, status: 200 };
    },
  });

  await engine.afterTurn({
    sessionId: "test",
    sessionFile: "/tmp/session.json",
    messages: [
      { role: "user", content: [{ type: "text", text: "user message" }] },
      { role: "assistant", content: [{ type: "text", text: "assistant reply" }] },
    ],
    prePromptMessageCount: 0,
  });

  assert.strictEqual(calls[0].body.session.prompt, "user message");
  assert.strictEqual(calls[0].body.session.response, "assistant reply");
});

test("afterTurn filters non-text content blocks", async () => {
  const calls = [];
  const engine = createMunnaiContextEngine({
    config: { baseUrl: "http://localhost:3100", enabled: true, timeoutMs: 1000 },
    logger: {},
    fetchImpl: async (url, opts) => {
      calls.push({ body: JSON.parse(opts.body) });
      return { ok: true, status: 200 };
    },
  });

  await engine.afterTurn({
    sessionId: "test",
    sessionFile: "/tmp/session.json",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "text block" },
          { type: "tool_use", id: "123", name: "read" },
        ],
      },
    ],
    prePromptMessageCount: 0,
  });

  assert.strictEqual(calls[0].body.session.response, "text block");
});
