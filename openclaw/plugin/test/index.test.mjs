import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("plugin entry only wires hooks and no longer registers a context engine", async () => {
  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  const manifest = await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8");

  assert.match(source, /registerMuninnHooks\(api\)/);
  assert.doesNotMatch(source, /kind:\s*["']memory["']/);
  assert.doesNotMatch(manifest, /"kind"\s*:\s*"memory"/);
  assert.doesNotMatch(source, /registerContextEngine/);
  assert.doesNotMatch(source, /createMuninnContextEngine/);
  assert.match(source, /hook-based writes with hook-based recall injection/);
});
