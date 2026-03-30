import test from "node:test";
import assert from "node:assert/strict";

import { extractDirectTargetPaths } from "../dist/src/path-extract.js";

test("extractDirectTargetPaths resolves write/edit paths directly", () => {
  assert.deepEqual(extractDirectTargetPaths("write", { path: "docs/a.md" }), ["docs/a.md"]);
  assert.deepEqual(extractDirectTargetPaths("edit", { path: "src/a.ts" }), ["src/a.ts"]);
});

test("extractDirectTargetPaths parses apply_patch multi-file paths", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/a.ts",
    "@@",
    "-old",
    "+new",
    "*** Add File: docs/b.md",
    "+hello",
    "*** End Patch",
  ].join("\n");

  assert.deepEqual(extractDirectTargetPaths("apply_patch", { patch }), ["src/a.ts", "docs/b.md"]);
});

test("extractDirectTargetPaths only returns exec output paths when explicit", () => {
  const output = "Wrote report to ./tmp/result.json and copied ./tmp/log.txt";
  assert.deepEqual(extractDirectTargetPaths("exec", { output }), ["./tmp/result.json", "./tmp/log.txt"]);
  assert.deepEqual(extractDirectTargetPaths("exec", { output: "command succeeded" }), []);
});
