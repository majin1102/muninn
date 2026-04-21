import test from "node:test";
import assert from "node:assert/strict";

import { resolvePluginConfig } from "../dist/src/config.js";

test("resolvePluginConfig falls back to the default recallLimit", () => {
  const config = resolvePluginConfig({
    baseUrl: "http://localhost:3100",
  });

  assert.ok(config);
  assert.equal(config.recallLimit, 3);
});

test("resolvePluginConfig accepts a positive integer recallLimit", () => {
  const config = resolvePluginConfig({
    baseUrl: "http://localhost:3100",
    recallLimit: 8,
  });

  assert.ok(config);
  assert.equal(config.recallLimit, 8);
});

test("resolvePluginConfig ignores invalid recallLimit values", () => {
  const config = resolvePluginConfig({
    baseUrl: "http://localhost:3100",
    recallLimit: 0,
  });

  assert.ok(config);
  assert.equal(config.recallLimit, 3);
});

test("resolvePluginConfig returns null without baseUrl", () => {
  assert.equal(resolvePluginConfig(undefined), null);
});
