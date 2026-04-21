import test from "node:test";
import assert from "node:assert/strict";

import { createMuninnClient } from "../dist/src/client.js";

test("createMuninnClient swallows fetch failures", async () => {
  const warnings = [];
  const client = createMuninnClient({
    config: {
      baseUrl: "http://127.0.0.1:8787",
      enabled: true,
      timeoutMs: 100,
      recallLimit: 3,
    },
    logger: {
      warn: (message) => warnings.push(message),
    },
    fetchImpl: async () => {
      throw new Error("boom");
    },
  });

  await client.captureTurn({
    turn: {
      sessionId: "group-a",
      agent: "main",
      prompt: "hello",
      response: "done",
    },
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /muninn write request failed/i);
});

test("createMuninnClient logs non-ok responses", async () => {
  const warnings = [];
  const client = createMuninnClient({
    config: {
      baseUrl: "http://127.0.0.1:8787",
      enabled: true,
      timeoutMs: 100,
      recallLimit: 3,
    },
    logger: {
      warn: (message) => warnings.push(message),
    },
    fetchImpl: async () => new Response("bad request", { status: 400 }),
  });

  await client.captureTurn({
    turn: {
      sessionId: "group-a",
      agent: "main",
      prompt: "hello",
      response: "done",
    },
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /status 400/i);
});

test("createMuninnClient recall returns trimmed content in response order", async () => {
  const client = createMuninnClient({
    config: {
      baseUrl: "http://127.0.0.1:8787",
      enabled: true,
      timeoutMs: 100,
      recallLimit: 3,
    },
    logger: {},
    fetchImpl: async (input) => {
      assert.match(String(input), /\/api\/v1\/recall\?query=hello\+world&limit=3$/);
      return new Response(JSON.stringify({
        memoryHits: [
          { content: " first " },
          { content: "" },
          { content: "second" },
        ],
      }), { status: 200 });
    },
  });

  const result = await client.recall("hello world");

  assert.deepEqual(result, ["first", "second"]);
});

test("createMuninnClient recall swallows fetch failures", async () => {
  const warnings = [];
  const client = createMuninnClient({
    config: {
      baseUrl: "http://127.0.0.1:8787",
      enabled: true,
      timeoutMs: 100,
      recallLimit: 3,
    },
    logger: {
      warn: (message) => warnings.push(message),
    },
    fetchImpl: async () => {
      throw new Error("boom");
    },
  });

  const result = await client.recall("hello");

  assert.deepEqual(result, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /muninn recall request failed/i);
});

test("createMuninnClient recall logs non-ok responses", async () => {
  const warnings = [];
  const client = createMuninnClient({
    config: {
      baseUrl: "http://127.0.0.1:8787",
      enabled: true,
      timeoutMs: 100,
      recallLimit: 3,
    },
    logger: {
      warn: (message) => warnings.push(message),
    },
    fetchImpl: async () => new Response("bad request", { status: 400 }),
  });

  const result = await client.recall("hello");

  assert.deepEqual(result, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /muninn recall failed with status 400/i);
});
