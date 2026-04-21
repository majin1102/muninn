import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const helperDir = path.dirname(fileURLToPath(import.meta.url));

export const pluginRoot = path.resolve(helperDir, "../..");
export const mockRuntimeFixturePath = path.join(
  pluginRoot,
  "test/fixtures/before-prompt-build.runtime.e2e.mjs",
);
export const liveRuntimeFixturePath = path.join(
  pluginRoot,
  "test/fixtures/before-prompt-build.live.e2e.mjs",
);
export const sidecarDistEntryPath = path.resolve(
  pluginRoot,
  "../../packages/sidecar/dist/index.js",
);

export function resolveOpenClawRoot() {
  const fromEnv = process.env.OPENCLAW_REPO_ROOT?.trim();
  const candidate = fromEnv || path.resolve(pluginRoot, "../../../openclaw");
  const resolved = path.resolve(candidate);
  const packageJsonPath = path.join(resolved, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(
      `OpenClaw repo root not found. Set OPENCLAW_REPO_ROOT or place the repo at ${path.resolve(pluginRoot, "../../../openclaw")}`,
    );
  }
  return resolved;
}

export function resolveTsxLoaderPath() {
  const loaderPath = path.join(resolveOpenClawRoot(), "node_modules/tsx/dist/loader.mjs");
  if (!fs.existsSync(loaderPath)) {
    throw new Error(`tsx loader not found at ${loaderPath}. Install OpenClaw dependencies first.`);
  }
  return loaderPath;
}
