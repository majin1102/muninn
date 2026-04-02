import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createMuninnContextEngine } from "../dist/src/context-engine.js";

test("integration: assemble calls /api/v1/list", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ memoryHits: [{ content: "test memory" }] }));
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const engine = createMuninnContextEngine({
      config: { baseUrl: `http://localhost:${port}`, enabled: true, timeoutMs: 1000, recencyLimit: 5 },
      logger: {},
    });

    const result = await engine.assemble({
      sessionId: "test",
      messages: [{ role: "user", content: "hello" }],
    });

    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].method, "GET");
    assert.match(requests[0].url, /^\/api\/v1\/list\?mode=recency&limit=5/);
    assert.ok(result.systemPromptAddition?.includes("test memory"));
  } finally {
    server.close();
  }
});

test("integration: assemble honors configured recencyLimit", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ memoryHits: [{ content: "test memory" }] }));
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const engine = createMuninnContextEngine({
      config: { baseUrl: `http://localhost:${port}`, enabled: true, timeoutMs: 1000, recencyLimit: 9 },
      logger: {},
    });

    await engine.assemble({
      sessionId: "test",
      messages: [{ role: "user", content: "hello" }],
    });

    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].method, "GET");
    assert.match(requests[0].url, /^\/api\/v1\/list\?mode=recency&limit=9/);
  } finally {
    server.close();
  }
});

test("integration: context engine does not write turns through afterTurn", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url.startsWith("/api/v1/list")) {
      requests.push({ method: "GET", url: req.url });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ memoryHits: [{ content: "recalled memory" }] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const engine = createMuninnContextEngine({
      config: { baseUrl: `http://localhost:${port}`, enabled: true, timeoutMs: 1000, recencyLimit: 5 },
      logger: {},
    });

    const assembleResult = await engine.assemble({
      sessionId: "test",
      messages: [{ role: "user", content: "query" }],
    });

    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].method, "GET");
    assert.ok(assembleResult.systemPromptAddition?.includes("recalled memory"));
    assert.strictEqual(engine.afterTurn, undefined);
  } finally {
    server.close();
  }
});

test("integration: server error does not throw", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(500);
    res.end("Internal Server Error");
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const warnings = [];
    const engine = createMuninnContextEngine({
      config: { baseUrl: `http://localhost:${port}`, enabled: true, timeoutMs: 1000, recencyLimit: 5 },
      logger: { warn: (msg) => warnings.push(msg) },
    });

    const result = await engine.assemble({
      sessionId: "test",
      messages: [{ role: "user", content: "hello" }],
    });

    assert.strictEqual(result.systemPromptAddition, undefined);
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /muninn recall failed: 500/);
  } finally {
    server.close();
  }
});
