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
      recencyLimit: 5,
    },
    logger: {},
    on(name, handler) {
      handlers.set(name, handler);
    },
  });

  await handlers.get("after_tool_call")({
    toolName: "read",
    params: { path: "note.txt" },
    toolCallId: "tool-1",
    result: "ok",
  }, {
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
      recencyLimit: 5,
    },
    logger: {},
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
    workspaceDir: dir,
  });

  await writeFile(file, "second", "utf8");

  await handlers.get("after_tool_call")({
    toolName: "read",
    params: { path: "note.txt" },
  }, {
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
      recencyLimit: 5,
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
    agentId: "agent-a",
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /after_tool_call missing sessionKey/i);
});
