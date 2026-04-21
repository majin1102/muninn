import test from "node:test";
import assert from "node:assert/strict";

import { ensureOpenClawPackageLink } from "./helpers/openclaw-link.mjs";
import { liveRuntimeFixturePath, pluginRoot, resolveOpenClawRoot, resolveTsxLoaderPath } from "./helpers/paths.mjs";
import { runNodeTestFixture } from "./helpers/run-node-test-fixture.mjs";

test("live runtime e2e: before_prompt_build recall closes the loop through sidecar, plugin loader, and provider", async (t) => {
  const apiKey = process.env.MUNINN_OPENCLAW_LIVE_OPENAI_API_KEY?.trim();
  assert.ok(
    apiKey,
    "MUNINN_OPENCLAW_LIVE_OPENAI_API_KEY is required for pnpm test:live",
  );

  const link = await ensureOpenClawPackageLink({ selfLink: true });
  t.after(async () => {
    await link.cleanup();
  });

  const result = await runNodeTestFixture({
    fixturePath: liveRuntimeFixturePath,
    cwd: pluginRoot,
    loaderPath: resolveTsxLoaderPath(),
    timeoutMs: 300_000,
    env: {
      OPENCLAW_REPO_ROOT: resolveOpenClawRoot(),
      MUNINN_OPENCLAW_LIVE_OPENAI_API_KEY: apiKey,
      ...(process.env.MUNINN_OPENCLAW_LIVE_MODEL
        ? { MUNINN_OPENCLAW_LIVE_MODEL: process.env.MUNINN_OPENCLAW_LIVE_MODEL }
        : {}),
      ...(process.env.MUNINN_OPENCLAW_LIVE_OPENAI_BASE_URL
        ? { MUNINN_OPENCLAW_LIVE_OPENAI_BASE_URL: process.env.MUNINN_OPENCLAW_LIVE_OPENAI_BASE_URL }
        : {}),
      ...(process.env.MUNINN_OPENCLAW_LIVE_MODEL_API
        ? { MUNINN_OPENCLAW_LIVE_MODEL_API: process.env.MUNINN_OPENCLAW_LIVE_MODEL_API }
        : {}),
      ...(process.env.MUNINN_OPENCLAW_LIVE_MUNINN_CONFIG_PATH
        ? { MUNINN_OPENCLAW_LIVE_MUNINN_CONFIG_PATH: process.env.MUNINN_OPENCLAW_LIVE_MUNINN_CONFIG_PATH }
        : {}),
      ...(process.env.MUNINN_OPENCLAW_LIVE_PLUGIN_TIMEOUT_MS
        ? { MUNINN_OPENCLAW_LIVE_PLUGIN_TIMEOUT_MS: process.env.MUNINN_OPENCLAW_LIVE_PLUGIN_TIMEOUT_MS }
        : {}),
      ...(process.env.MUNINN_OPENCLAW_LIVE_SEED_RECALL_TIMEOUT_MS
        ? { MUNINN_OPENCLAW_LIVE_SEED_RECALL_TIMEOUT_MS: process.env.MUNINN_OPENCLAW_LIVE_SEED_RECALL_TIMEOUT_MS }
        : {}),
    },
  });
  assert.match(
    result.output,
    /live runtime e2e: recall is injected into provider system input and stored prompt stays clean/,
    result.output || "live fixture did not emit the expected test output",
  );
  assert.match(
    result.output,
    /tests 1/,
    result.output || "live fixture did not report one executed test",
  );
  if (result.exitCode !== 0) {
    assert.fail(result.output || `live fixture exited with code ${result.exitCode}`);
  }
});
