import { spawn } from "node:child_process";

export function runNodeTestFixture({
  fixturePath,
  cwd,
  loaderPath,
  timeoutMs = 30_000,
  env = {},
  enableModuleMocks = false,
}) {
  return new Promise((resolve) => {
    const args = [];
    if (enableModuleMocks) {
      args.push("--experimental-test-module-mocks");
    }
    args.push("--import", loaderPath, "--test", fixturePath);

    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...withoutNodeTestEnv(process.env),
        CI: "1",
        ...env,
      },
    });

    let output = "";
    let killed = false;
    const timeout = setTimeout(() => {
      killed = child.kill("SIGTERM");
      setTimeout(() => {
        if (killed) {
          child.kill("SIGKILL");
        }
      }, 5_000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({
        exitCode: exitCode ?? 1,
        signal: signal ?? undefined,
        output,
      });
    });
  });
}

function withoutNodeTestEnv(env) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (key.startsWith("NODE_TEST")) {
      delete next[key];
    }
  }
  return next;
}
