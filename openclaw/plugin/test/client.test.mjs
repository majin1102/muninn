import test from "node:test";
import assert from "node:assert/strict";

import { createMunnaiClient } from "../dist/src/client.js";

test("createMunnaiClient swallows fetch failures", async () => {
  const warnings = [];
  const client = createMunnaiClient({
    config: {
      baseUrl: "http://127.0.0.1:8787",
      enabled: true,
      timeoutMs: 100,
    },
    logger: {
      warn: (message) => warnings.push(message),
    },
    fetchImpl: async () => {
      throw new Error("boom");
    },
  });

  await client.sendMessage({
    session: {
      agent: "main",
      prompt: "hello",
    },
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /munnai write request failed/i);
});

test("createMunnaiClient logs non-ok responses", async () => {
  const warnings = [];
  const client = createMunnaiClient({
    config: {
      baseUrl: "http://127.0.0.1:8787",
      enabled: true,
      timeoutMs: 100,
    },
    logger: {
      warn: (message) => warnings.push(message),
    },
    fetchImpl: async () => new Response("bad request", { status: 400 }),
  });

  await client.sendMessage({
    session: {
      agent: "main",
      prompt: "hello",
    },
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /status 400/i);
});
