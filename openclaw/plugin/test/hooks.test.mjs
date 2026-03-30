import test from "node:test";
import assert from "node:assert/strict";

import { extractFinalAssistantText } from "../dist/src/hooks.js";

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
