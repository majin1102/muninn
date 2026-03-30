import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createMunnaiContextEngine } from "../dist/src/context-engine.js";

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
    const engine = createMunnaiContextEngine({
      config: { baseUrl: `http://localhost:${port}`, enabled: true, timeoutMs: 1000 },
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

test("integration: afterTurn calls /api/v1/session/messages", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body: JSON.parse(body) });
      res.writeHead(200);
      res.end();
    });
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const engine = createMunnaiContextEngine({
      config: { baseUrl: `http://localhost:${port}`, enabled: true, timeoutMs: 1000 },
      logger: {},
    });

    await engine.afterTurn({
      sessionId: "test-session",
      sessionFile: "/tmp/session.json",
      messages: [
        { role: "user", content: "user text" },
        { role: "assistant", content: "assistant text" },
      ],
      prePromptMessageCount: 0,
    });

    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].method, "POST");
    assert.strictEqual(requests[0].url, "/api/v1/session/messages");
    assert.strictEqual(requests[0].body.session.session_id, "test-session");
    assert.strictEqual(requests[0].body.session.prompt, "user text");
    assert.strictEqual(requests[0].body.session.response, "assistant text");
  } finally {
    server.close();
  }
});

test("integration: full turn flow (assemble + afterTurn)", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url.startsWith("/api/v1/list")) {
      requests.push({ method: "GET", url: req.url });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ memoryHits: [{ content: "recalled memory" }] }));
    } else if (req.method === "POST" && req.url === "/api/v1/session/messages") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requests.push({ method: "POST", url: req.url, body: JSON.parse(body) });
        res.writeHead(200);
        res.end();
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const engine = createMunnaiContextEngine({
      config: { baseUrl: `http://localhost:${port}`, enabled: true, timeoutMs: 1000 },
      logger: {},
    });

    const assembleResult = await engine.assemble({
      sessionId: "test",
      messages: [{ role: "user", content: "query" }],
    });

    await engine.afterTurn({
      sessionId: "test",
      sessionFile: "/tmp/session.json",
      messages: [
        { role: "user", content: "query" },
        { role: "assistant", content: "answer" },
      ],
      prePromptMessageCount: 0,
    });

    assert.strictEqual(requests.length, 2);
    assert.strictEqual(requests[0].method, "GET");
    assert.strictEqual(requests[1].method, "POST");
    assert.ok(assembleResult.systemPromptAddition?.includes("recalled memory"));
    assert.strictEqual(requests[1].body.session.prompt, "query");
    assert.strictEqual(requests[1].body.session.response, "answer");
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
    const engine = createMunnaiContextEngine({
      config: { baseUrl: `http://localhost:${port}`, enabled: true, timeoutMs: 1000 },
      logger: { warn: (msg) => warnings.push(msg) },
    });

    const result = await engine.assemble({
      sessionId: "test",
      messages: [{ role: "user", content: "hello" }],
    });

    assert.strictEqual(result.systemPromptAddition, undefined);
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /munnai recall failed: 500/);
  } finally {
    server.close();
  }
});
