import test from "node:test";
import assert from "node:assert/strict";

import { resolvePluginConfig } from "../dist/src/config.js";

test("resolvePluginConfig falls back to the default recencyLimit", () => {
  const config = resolvePluginConfig({
    baseUrl: "http://localhost:3100",
  });

  assert.ok(config);
  assert.equal(config.recencyLimit, 5);
});

test("resolvePluginConfig accepts a positive integer recencyLimit", () => {
  const config = resolvePluginConfig({
    baseUrl: "http://localhost:3100",
    recencyLimit: 8,
  });

  assert.ok(config);
  assert.equal(config.recencyLimit, 8);
});

test("resolvePluginConfig ignores invalid recencyLimit values", () => {
  const config = resolvePluginConfig({
    baseUrl: "http://localhost:3100",
    recencyLimit: 0,
  });

  assert.ok(config);
  assert.equal(config.recencyLimit, 5);
});
