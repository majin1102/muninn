import test from "node:test";
import assert from "node:assert/strict";

import { buildCapturePayload } from "../dist/src/payloads.js";

test("buildCapturePayload maps a complete turn into turn/capture shape", () => {
  assert.deepEqual(
    buildCapturePayload({
      sessionKey: "agent:main:main",
      agentId: "main",
      prompt: "hello",
      response: "done",
      events: [{ type: "toolCall", name: "read", input: "{\"path\":\"a.ts\"}" }],
      artifacts: [{ key: "a.ts", kind: "text", source: "tool", content: "export {};" }],
    }),
    {
      turn: {
        sessionId: "agent:main:main",
        agent: "main",
        prompt: "hello",
        response: "done",
        events: [
          { type: "userMessage", text: "hello" },
          { type: "toolCall", name: "read", input: "{\"path\":\"a.ts\"}" },
          { type: "assistantMessage", text: "done" },
        ],
        artifacts: [{ key: "a.ts", kind: "text", source: "tool", content: "export {};" }],
      },
    },
  );
});

test("buildCapturePayload rejects incomplete turns", () => {
  assert.equal(
    buildCapturePayload({
      sessionKey: "group-a",
      agentId: "coder",
      prompt: "hello",
      response: "   ",
    }),
    null,
  );
});
