import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { extractFinalAssistantText, registerMuninnHooks } from "../dist/src/hooks.js";

test("extractFinalAssistantText returns the last assistant text block", () => {
  const text = extractFinalAssistantText({
    success: true,
    messages: [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "final answer" },
        ],
      },
    ],
  });

  assert.equal(text, "final answer");
});

test("extractFinalAssistantText ignores non-assistant messages", () => {
  const text = extractFinalAssistantText({
    success: false,
    messages: [
      { role: "user", content: "hello" },
    ],
  });

  assert.equal(text, "");
});

test("registerMuninnHooks adds recall context during before_prompt_build", async (t) => {
  const handlers = new Map();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({
      memoryHits: [
        { content: "first memory" },
        { content: "second memory" },
      ],
    }), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  registerMuninnHooks({
    pluginConfig: {
      enabled: true,
      baseUrl: "http://muninn.test",
      timeoutMs: 1_000,
      recallLimit: 3,
    },
    logger: {},
    on(name, handler) {
      handlers.set(name, handler);
    },
  });

  const result = await handlers.get("before_prompt_build")({
    prompt: "what did we decide?",
    messages: [],
  }, {});

  assert.match(calls[0], /\/api\/v1\/recall\?query=what\+did\+we\+decide%3F&limit=3$/);
  assert.deepEqual(result, {
    appendSystemContext: "<relevant-memories>\nfirst memory\n\nsecond memory\n</relevant-memories>",
  });
});

test("registerMuninnHooks skips recall injection when no hits are returned", async (t) => {
  const handlers = new Map();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ memoryHits: [] }), { status: 200 });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  registerMuninnHooks({
    pluginConfig: {
      enabled: true,
      baseUrl: "http://muninn.test",
      timeoutMs: 1_000,
      recallLimit: 3,
    },
    logger: {},
    on(name, handler) {
      handlers.set(name, handler);
    },
  });

  const result = await handlers.get("before_prompt_build")({
    prompt: "what happened before",
    messages: [],
  }, {});

  assert.equal(result, undefined);
});

test("registerMuninnHooks swallows recall failures during before_prompt_build", async (t) => {
  const handlers = new Map();
  const warnings = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("bad request", { status: 400 });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  registerMuninnHooks({
    pluginConfig: {
      enabled: true,
      baseUrl: "http://muninn.test",
      timeoutMs: 1_000,
      recallLimit: 3,
    },
    logger: {
      warn: (message) => warnings.push(message),
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
  });

  const result = await handlers.get("before_prompt_build")({
    prompt: "remember this",
    messages: [],
  }, {});

  assert.equal(result, undefined);
  assert.match(warnings[0], /muninn recall failed with status 400/i);
});

test("registerMuninnHooks captures after_tool_call artifacts and clears cache after agent_end", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "muninn-openclaw-hooks-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  await writeFile(path.join(dir, "note.txt"), "first artifact", "utf8");

  const handlers = new Map();
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 204,
      async text() {
        return "";
      },
    };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  registerMuninnHooks({
    pluginConfig: {
      enabled: true,
      baseUrl: "http://muninn.test",
      timeoutMs: 1_000,
      recallLimit: 5,
    },
    logger: {},
    on(name, handler) {
      handlers.set(name, handler);
    },
  });

  await handlers.get("after_tool_call")({
    toolName: "read",
    params: { path: "note.txt" },
    runId: "run-1",
    toolCallId: "tool-1",
    result: "ok",
  }, {
    runId: "run-1",
    sessionKey: "group-a",
    agentId: "agent-a",
    workspaceDir: dir,
  });

  await handlers.get("agent_end")({
    success: true,
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ],
  }, {
    runId: "run-1",
    sessionKey: "group-a",
    agentId: "agent-a",
    workspaceDir: dir,
  });

  await handlers.get("agent_end")({
    success: true,
    messages: [
      { role: "user", content: "hello again" },
      { role: "assistant", content: [{ type: "text", text: "done again" }] },
    ],
  }, {
    runId: "run-2",
    sessionKey: "group-a",
    agentId: "agent-a",
    workspaceDir: dir,
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], {
    turn: {
      sessionId: "group-a",
      agent: "agent-a",
      prompt: "hello",
      response: "done",
      toolCalls: [{
        id: "tool-1",
        name: "read",
        input: "{\"path\":\"note.txt\"}",
        output: "ok",
      }],
      artifacts: [{
        key: "note.txt",
        content: "first artifact",
      }],
    },
  });
  assert.deepEqual(requests[1], {
    turn: {
      sessionId: "group-a",
      agent: "agent-a",
      prompt: "hello again",
      response: "done again",
    },
  });
});

test("registerMuninnHooks keeps the latest artifact content for the same path", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "muninn-openclaw-hooks-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const file = path.join(dir, "note.txt");
  await writeFile(file, "first", "utf8");

  const handlers = new Map();
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 204,
      async text() {
        return "";
      },
    };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  registerMuninnHooks({
    pluginConfig: {
      enabled: true,
      baseUrl: "http://muninn.test",
      timeoutMs: 1_000,
      recallLimit: 5,
    },
    logger: {},
    on(name, handler) {
      handlers.set(name, handler);
    },
  });

  await handlers.get("after_tool_call")({
    toolName: "read",
    params: { path: "note.txt" },
    runId: "run-1",
  }, {
    runId: "run-1",
    sessionKey: "group-a",
    agentId: "agent-a",
    workspaceDir: dir,
  });

  await writeFile(file, "second", "utf8");

  await handlers.get("after_tool_call")({
    toolName: "read",
    params: { path: "note.txt" },
    runId: "run-1",
  }, {
    runId: "run-1",
    sessionKey: "group-a",
    agentId: "agent-a",
    workspaceDir: dir,
  });

  await handlers.get("agent_end")({
    success: true,
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ],
  }, {
    runId: "run-1",
    sessionKey: "group-a",
    agentId: "agent-a",
    workspaceDir: dir,
  });

  assert.deepEqual(requests[0].turn.artifacts, [{
    key: "note.txt",
    content: "second",
  }]);
});

test("registerMuninnHooks warns and skips cache when after_tool_call has no sessionKey", async () => {
  const handlers = new Map();
  const warnings = [];

  registerMuninnHooks({
    pluginConfig: {
      enabled: true,
      baseUrl: "http://muninn.test",
      timeoutMs: 1_000,
      recallLimit: 5,
    },
    logger: {
      warn: (message) => warnings.push(message),
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
  });

  await handlers.get("after_tool_call")({
    toolName: "read",
    runId: "run-1",
    params: { path: "note.txt" },
  }, {
    agentId: "agent-a",
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /after_tool_call missing sessionKey/i);
});

test("registerMuninnHooks warns and skips cache when after_tool_call has no runId", async () => {
  const handlers = new Map();
  const warnings = [];

  registerMuninnHooks({
    pluginConfig: {
      enabled: true,
      baseUrl: "http://muninn.test",
      timeoutMs: 1_000,
      recallLimit: 5,
    },
    logger: {
      warn: (message) => warnings.push(message),
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
  });

  await handlers.get("after_tool_call")({
    toolName: "read",
    params: { path: "note.txt" },
  }, {
    sessionKey: "group-a",
    agentId: "agent-a",
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /after_tool_call missing runId/i);
});

test("registerMuninnHooks warns and skips cache when after_tool_call has no agentId", async () => {
  const handlers = new Map();
  const warnings = [];

  registerMuninnHooks({
    pluginConfig: {
      enabled: true,
      baseUrl: "http://muninn.test",
      timeoutMs: 1_000,
      recallLimit: 5,
    },
    logger: {
      warn: (message) => warnings.push(message),
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
  });

  await handlers.get("after_tool_call")({
    toolName: "read",
    params: { path: "note.txt" },
    runId: "run-1",
  }, {
    sessionKey: "group-a",
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /after_tool_call missing agentId/i);
});

test("registerMuninnHooks collects artifacts from tool result paths", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "muninn-openclaw-hooks-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  await writeFile(path.join(dir, "note.txt"), "from result path", "utf8");

  const handlers = new Map();
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 204,
      async text() {
        return "";
      },
    };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  registerMuninnHooks({
    pluginConfig: {
      enabled: true,
      baseUrl: "http://muninn.test",
      timeoutMs: 1_000,
      recallLimit: 5,
    },
    logger: {},
    on(name, handler) {
      handlers.set(name, handler);
    },
  });

  await handlers.get("after_tool_call")({
    toolName: "exec",
    params: { command: "cat note.txt" },
    runId: "run-1",
    result: "Wrote output to ./note.txt",
  }, {
    runId: "run-1",
    sessionKey: "group-a",
    agentId: "agent-a",
    workspaceDir: dir,
  });

  await handlers.get("agent_end")({
    success: true,
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ],
  }, {
    runId: "run-1",
    sessionKey: "group-a",
    agentId: "agent-a",
    workspaceDir: dir,
  });

  assert.deepEqual(requests[0].turn.artifacts, [{
    key: "./note.txt",
    content: "from result path",
  }]);
});

test("registerMuninnHooks prefers ctx.runId and isolates cached data per run", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "muninn-openclaw-hooks-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  await writeFile(path.join(dir, "note.txt"), "first artifact", "utf8");

  const handlers = new Map();
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 204,
      async text() {
        return "";
      },
    };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  registerMuninnHooks({
    pluginConfig: {
      enabled: true,
      baseUrl: "http://muninn.test",
      timeoutMs: 1_000,
      recallLimit: 5,
    },
    logger: {},
    on(name, handler) {
      handlers.set(name, handler);
    },
  });

  await handlers.get("after_tool_call")({
    toolName: "read",
    params: { path: "note.txt" },
    runId: "event-run-1",
    toolCallId: "tool-1",
    result: "ok",
  }, {
    runId: "ctx-run-1",
    sessionKey: "group-a",
    agentId: "agent-a",
    workspaceDir: dir,
  });

  await handlers.get("after_tool_call")({
    toolName: "edit",
    params: { path: "note.txt" },
    runId: "event-run-2",
    toolCallId: "tool-2",
    result: "ok",
  }, {
    runId: "ctx-run-2",
    sessionKey: "group-a",
    agentId: "agent-a",
    workspaceDir: dir,
  });

  await handlers.get("agent_end")({
    success: true,
    messages: [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "end-tool", name: "read", arguments: { path: "note.txt" } },
          { type: "text", text: "done" },
        ],
      },
    ],
  }, {
    runId: "ctx-run-1",
    sessionKey: "group-a",
    agentId: "agent-a",
    workspaceDir: dir,
  });

  await handlers.get("agent_end")({
    success: true,
    messages: [
      { role: "user", content: "hello again" },
      { role: "assistant", content: [{ type: "text", text: "done again" }] },
    ],
  }, {
    runId: "ctx-run-2",
    sessionKey: "group-a",
    agentId: "agent-a",
    workspaceDir: dir,
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], {
    turn: {
      sessionId: "group-a",
      agent: "agent-a",
      prompt: "hello",
      response: "done",
      toolCalls: [{
        id: "tool-1",
        name: "read",
        input: "{\"path\":\"note.txt\"}",
        output: "ok",
      }],
      artifacts: [{
        key: "note.txt",
        content: "first artifact",
      }],
    },
  });
  assert.deepEqual(requests[1], {
    turn: {
      sessionId: "group-a",
      agent: "agent-a",
      prompt: "hello again",
      response: "done again",
      toolCalls: [{
        id: "tool-2",
        name: "edit",
        input: "{\"path\":\"note.txt\"}",
        output: "ok",
      }],
      artifacts: [{
        key: "note.txt",
        content: "first artifact",
      }],
    },
  });
});

test("registerMuninnHooks falls back to agent_end tool calls when ctx.runId is missing", async () => {
  const handlers = new Map();
  const requests = [];
  const warnings = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 204,
      async text() {
        return "";
      },
    };
  };
  try {
    registerMuninnHooks({
      pluginConfig: {
        enabled: true,
        baseUrl: "http://muninn.test",
        timeoutMs: 1_000,
        recallLimit: 5,
      },
      logger: {
        warn: (message) => warnings.push(message),
      },
      on(name, handler) {
        handlers.set(name, handler);
      },
    });

    await handlers.get("agent_end")({
      success: true,
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "end-tool", name: "read", arguments: { path: "note.txt" } },
            { type: "text", text: "done" },
          ],
        },
      ],
    }, {
      sessionKey: "group-a",
      agentId: "agent-a",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /agent_end missing runId/i);
  assert.deepEqual(requests, [{
    turn: {
      sessionId: "group-a",
      agent: "agent-a",
      prompt: "hello",
      response: "done",
      toolCalls: [{
        id: "end-tool",
        name: "read",
        input: "{\"path\":\"note.txt\"}",
      }],
    },
  }]);
});

test("registerMuninnHooks consumes cached state when agent_end has runId but missing agentId", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "muninn-openclaw-hooks-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  await writeFile(path.join(dir, "note.txt"), "stale artifact", "utf8");

  const handlers = new Map();
  const requests = [];
  const warnings = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 204,
      async text() {
        return "";
      },
    };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  registerMuninnHooks({
    pluginConfig: {
      enabled: true,
      baseUrl: "http://muninn.test",
      timeoutMs: 1_000,
      recallLimit: 5,
    },
    logger: {
      warn: (message) => warnings.push(message),
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
  });

  await handlers.get("after_tool_call")({
    toolName: "read",
    params: { path: "note.txt" },
    runId: "run-1",
    toolCallId: "tool-1",
    result: "ok",
  }, {
    runId: "run-1",
    sessionKey: "group-a",
    agentId: "agent-a",
    workspaceDir: dir,
  });

  await handlers.get("agent_end")({
    success: true,
    messages: [
      { role: "user", content: "ignored" },
      { role: "assistant", content: [{ type: "text", text: "ignored" }] },
    ],
  }, {
    runId: "run-1",
    sessionKey: "group-a",
  });

  await handlers.get("agent_end")({
    success: true,
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ],
  }, {
    runId: "run-1",
    sessionKey: "group-a",
    agentId: "agent-a",
    workspaceDir: dir,
  });

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    turn: {
      sessionId: "group-a",
      agent: "agent-a",
      prompt: "hello",
      response: "done",
    },
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /agent_end missing agentId/i);
});

test("registerMuninnHooks isolates cache by runId within the same session and agent", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "muninn-openclaw-hooks-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  await writeFile(path.join(dir, "note.txt"), "shared artifact", "utf8");

  const handlers = new Map();
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 204,
      async text() {
        return "";
      },
    };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  registerMuninnHooks({
    pluginConfig: {
      enabled: true,
      baseUrl: "http://muninn.test",
      timeoutMs: 1_000,
      recallLimit: 5,
    },
    logger: {},
    on(name, handler) {
      handlers.set(name, handler);
    },
  });

  await handlers.get("after_tool_call")({
    toolName: "read",
    params: { path: "note.txt" },
    runId: "run-a",
    toolCallId: "tool-a",
    result: "ok",
  }, {
    runId: "run-a",
    sessionKey: "group-a",
    agentId: "agent-a",
    workspaceDir: dir,
  });

  await handlers.get("after_tool_call")({
    toolName: "read",
    params: { path: "note.txt" },
    runId: "run-b",
    toolCallId: "tool-b",
    result: "ok",
  }, {
    runId: "run-b",
    sessionKey: "group-a",
    agentId: "agent-a",
    workspaceDir: dir,
  });

  await handlers.get("agent_end")({
    success: true,
    messages: [
      { role: "user", content: "hello from a" },
      { role: "assistant", content: [{ type: "text", text: "done a" }] },
    ],
  }, {
    runId: "run-a",
    sessionKey: "group-a",
    agentId: "agent-a",
    workspaceDir: dir,
  });

  await handlers.get("agent_end")({
    success: true,
    messages: [
      { role: "user", content: "hello from b" },
      { role: "assistant", content: [{ type: "text", text: "done b" }] },
    ],
  }, {
    runId: "run-b",
    sessionKey: "group-a",
    agentId: "agent-a",
    workspaceDir: dir,
  });

  assert.deepEqual(requests, [
    {
      turn: {
        sessionId: "group-a",
        agent: "agent-a",
        prompt: "hello from a",
        response: "done a",
        toolCalls: [{
          id: "tool-a",
          name: "read",
          input: "{\"path\":\"note.txt\"}",
          output: "ok",
        }],
        artifacts: [{
          key: "note.txt",
          content: "shared artifact",
        }],
      },
    },
    {
      turn: {
        sessionId: "group-a",
        agent: "agent-a",
        prompt: "hello from b",
        response: "done b",
        toolCalls: [{
          id: "tool-b",
          name: "read",
          input: "{\"path\":\"note.txt\"}",
          output: "ok",
        }],
        artifacts: [{
          key: "note.txt",
          content: "shared artifact",
        }],
      },
    },
  ]);
});

test("registerMuninnHooks evicts stale runs on agent_end after twenty four hours", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "muninn-openclaw-hooks-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  await writeFile(path.join(dir, "note.txt"), "stale artifact", "utf8");

  const handlers = new Map();
  const requests = [];
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 204,
      async text() {
        return "";
      },
    };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  });

  registerMuninnHooks({
    pluginConfig: {
      enabled: true,
      baseUrl: "http://muninn.test",
      timeoutMs: 1_000,
      recallLimit: 5,
    },
    logger: {},
    on(name, handler) {
      handlers.set(name, handler);
    },
  });

  await handlers.get("after_tool_call")({
    toolName: "read",
    params: { path: "note.txt" },
    runId: "stale-run",
    toolCallId: "tool-1",
    result: "ok",
  }, {
    runId: "stale-run",
    sessionKey: "group-a",
    agentId: "agent-a",
    workspaceDir: dir,
  });

  now += 24 * 60 * 60 * 1000 + 1;

  await handlers.get("agent_end")({
    success: true,
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ],
  }, {
    runId: "fresh-run",
    sessionKey: "group-a",
    agentId: "agent-a",
    workspaceDir: dir,
  });

  await handlers.get("agent_end")({
    success: true,
    messages: [
      { role: "user", content: "hello again" },
      { role: "assistant", content: [{ type: "text", text: "done again" }] },
    ],
  }, {
    runId: "stale-run",
    sessionKey: "group-a",
    agentId: "agent-a",
    workspaceDir: dir,
  });

  assert.deepEqual(requests, [
    {
      turn: {
        sessionId: "group-a",
        agent: "agent-a",
        prompt: "hello",
        response: "done",
      },
    },
    {
      turn: {
        sessionId: "group-a",
        agent: "agent-a",
        prompt: "hello again",
        response: "done again",
      },
    },
  ]);
});

test("registerMuninnHooks keeps current run cache when agent_end arrives after twenty four hours", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "muninn-openclaw-hooks-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  await writeFile(path.join(dir, "note.txt"), "late artifact", "utf8");

  const handlers = new Map();
  const requests = [];
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 204,
      async text() {
        return "";
      },
    };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  });

  registerMuninnHooks({
    pluginConfig: {
      enabled: true,
      baseUrl: "http://muninn.test",
      timeoutMs: 1_000,
      recallLimit: 5,
    },
    logger: {},
    on(name, handler) {
      handlers.set(name, handler);
    },
  });

  await handlers.get("after_tool_call")({
    toolName: "read",
    params: { path: "note.txt" },
    runId: "run-1",
    toolCallId: "tool-1",
    result: "ok",
  }, {
    runId: "run-1",
    sessionKey: "group-a",
    agentId: "agent-a",
    workspaceDir: dir,
  });

  now += 24 * 60 * 60 * 1000 + 1;

  await handlers.get("agent_end")({
    success: true,
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ],
  }, {
    runId: "run-1",
    sessionKey: "group-a",
    agentId: "agent-a",
    workspaceDir: dir,
  });

  assert.deepEqual(requests, [{
    turn: {
      sessionId: "group-a",
      agent: "agent-a",
      prompt: "hello",
      response: "done",
      toolCalls: [{
        id: "tool-1",
        name: "read",
        input: "{\"path\":\"note.txt\"}",
        output: "ok",
      }],
      artifacts: [{
        key: "note.txt",
        content: "late artifact",
      }],
    },
  }]);
});
