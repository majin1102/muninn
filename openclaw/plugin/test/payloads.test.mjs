import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPromptPayload,
  buildResponsePayload,
  buildToolPayload,
} from "../dist/src/payloads.js";

test("buildPromptPayload maps prompt into session message", () => {
  assert.deepEqual(
    buildPromptPayload({
      sessionKey: "agent:main:main",
      agentId: "main",
      prompt: "hello",
    }),
    {
      session: {
        session_id: "agent:main:main",
        agent: "main",
        prompt: "hello",
      },
    },
  );
});

test("buildToolPayload omits empty artifacts", () => {
  assert.deepEqual(
    buildToolPayload({
      sessionKey: "group-a",
      agentId: "coder",
      command: "write path=docs/a.md",
    }),
    {
      session: {
        session_id: "group-a",
        agent: "coder",
        tool_calling: ["write path=docs/a.md"],
      },
    },
  );
});

test("buildResponsePayload rejects blank response", () => {
  assert.equal(
    buildResponsePayload({
      sessionKey: "group-a",
      agentId: "coder",
      response: "   ",
    }),
    null,
  );
});
