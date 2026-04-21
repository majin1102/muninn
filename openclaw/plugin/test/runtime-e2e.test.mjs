import test from "node:test";
import assert from "node:assert/strict";
import { ensureOpenClawPackageLink } from "./helpers/openclaw-link.mjs";
import { pluginRoot, mockRuntimeFixturePath, resolveOpenClawRoot, resolveTsxLoaderPath } from "./helpers/paths.mjs";
import { runNodeTestFixture } from "./helpers/run-node-test-fixture.mjs";

const runMockRuntimeE2e = process.env.MUNINN_OPENCLAW_MOCK_RUNTIME_E2E === "1";

test("runtime e2e: before_prompt_build injects recall through real openclaw runner", {
  skip: runMockRuntimeE2e
    ? false
    : "set MUNINN_OPENCLAW_MOCK_RUNTIME_E2E=1 to run the OpenClaw module-mock runner harness",
}, async (t) => {
  const link = await ensureOpenClawPackageLink();
  t.after(async () => {
    await link.cleanup();
  });

  const result = await runNodeTestFixture({
    fixturePath: mockRuntimeFixturePath,
    cwd: pluginRoot,
    loaderPath: resolveTsxLoaderPath(),
    timeoutMs: 30_000,
    enableModuleMocks: true,
    env: {
      OPENCLAW_REPO_ROOT: resolveOpenClawRoot(),
    },
  });
  if (result.exitCode !== 0) {
    assert.fail(result.output || `vitest exited with code ${result.exitCode}`);
  }
});
