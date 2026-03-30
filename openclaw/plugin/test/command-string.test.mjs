import test from "node:test";
import assert from "node:assert/strict";

import { buildCommandString } from "../dist/src/command-string.js";

test("buildCommandString omits large content fields but keeps key arguments", () => {
  const command = buildCommandString("write", {
    path: "docs/test.md",
    content: "# long body\n".repeat(40),
  });

  assert.equal(command, 'write path=docs/test.md content=<omitted>');
});

test("buildCommandString preserves simple scalar params", () => {
  const command = buildCommandString("edit", {
    path: "src/index.ts",
    replaceAll: true,
  });

  assert.equal(command, "edit path=src/index.ts replaceAll=true");
});
