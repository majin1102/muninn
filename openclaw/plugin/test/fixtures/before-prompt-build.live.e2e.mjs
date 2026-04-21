import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import test from "node:test";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import { pluginRoot, resolveOpenClawRoot, sidecarDistEntryPath } from "../helpers/paths.mjs";

const OPENCLAW_ROOT = resolveOpenClawRoot();
const LIVE_MODEL = process.env.MUNINN_OPENCLAW_LIVE_MODEL?.trim() || "gpt-5.4-mini";
const LIVE_MODEL_API = normalizeLiveModelApi(process.env.MUNINN_OPENCLAW_LIVE_MODEL_API);
const OPENAI_API_KEY = process.env.MUNINN_OPENCLAW_LIVE_OPENAI_API_KEY?.trim();
const OPENAI_UPSTREAM_URL = (
  process.env.MUNINN_OPENCLAW_LIVE_OPENAI_BASE_URL?.trim()
  || "https://api.openai.com/v1/responses"
);
const LIVE_MUNINN_CONFIG_PATH = process.env.MUNINN_OPENCLAW_LIVE_MUNINN_CONFIG_PATH?.trim();
const LIVE_PLUGIN_TIMEOUT_MS = normalizePositiveInteger(
  process.env.MUNINN_OPENCLAW_LIVE_PLUGIN_TIMEOUT_MS,
  10_000,
);
const LIVE_SEED_RECALL_TIMEOUT_MS = normalizePositiveInteger(
  process.env.MUNINN_OPENCLAW_LIVE_SEED_RECALL_TIMEOUT_MS,
  120_000,
);

const openclawModulePath = (...segments) => path.join(OPENCLAW_ROOT, ...segments);
const openclawModuleUrl = (...segments) => pathToFileURL(openclawModulePath(...segments)).href;

test("live runtime e2e: recall is injected into provider system input and stored prompt stays clean", async (t) => {
  assert.ok(OPENAI_API_KEY, "MUNINN_OPENCLAW_LIVE_OPENAI_API_KEY is required");

  const fixtures = await import(
    openclawModuleUrl("src/agents/test-helpers/pi-embedded-runner-e2e-fixtures.ts")
  );
  const { runEmbeddedPiAgent } = await import(
    openclawModuleUrl("src/agents/pi-embedded-runner/run.ts")
  );

  const workspace = await fixtures.createEmbeddedPiRunnerTestWorkspace(
    "muninn-before-prompt-build-live-",
  );
  const muninnHome = await fs.mkdtemp(path.join(os.tmpdir(), "muninn-openclaw-live-home-"));
  const configPath = path.join(muninnHome, "muninn.json");
  const datasetDir = path.join(muninnHome, "dataset");
  const sessionFile = path.join(workspace.workspaceDir, "session.jsonl");

  t.after(async () => {
    await fixtures.cleanupEmbeddedPiRunnerTestWorkspace(workspace);
    await fs.rm(muninnHome, { recursive: true, force: true });
  });

  await writeMuninnConfig(configPath, {
    sourcePath: LIVE_MUNINN_CONFIG_PATH,
    storageUri: toFileStoreUri(datasetDir),
  });

  const sidecarPort = await getFreePort();
  const sidecar = startSidecar({
    cwd: path.resolve(pluginRoot, "../.."),
    entryPath: sidecarDistEntryPath,
    muninnHome,
    port: sidecarPort,
  });
  t.after(async () => {
    await stopChildProcess(sidecar.child);
  });

  const sidecarBaseUrl = `http://127.0.0.1:${sidecarPort}`;
  await waitForSidecarHealth(sidecarBaseUrl, () => sidecar.output);

  const seedToken = `frost-lantern-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const seedSubject = "Project Borealis rollback codename";
  const seedPrompt = `Important long-term memory: remember that the ${seedSubject} is ${seedToken}.`;
  const seedResponse = `Confirmed. The durable memory is that the ${seedSubject} is ${seedToken}.`;

  const captureResponse = await postJson(`${sidecarBaseUrl}/api/v1/turn/capture`, {
    turn: {
      sessionId: "seed-session",
      agent: "seed-agent",
      prompt: seedPrompt,
      response: seedResponse,
    },
  });
  assert.equal(captureResponse.status, 204);

  const seededRecall = await waitForSeedRecall({
    baseUrl: sidecarBaseUrl,
    query: `What is the ${seedSubject}?`,
    expectedText: seedToken,
    sidecarOutput: () => sidecar.output,
  });

  const proxy = await startOpenAiProxy({
    upstreamUrl: OPENAI_UPSTREAM_URL,
  });
  t.after(async () => {
    await proxy.close();
  });

  const config = createLiveOpenClawConfig({
    modelId: LIVE_MODEL,
    apiKey: OPENAI_API_KEY,
    api: LIVE_MODEL_API,
    proxyBaseUrl: proxy.baseUrl,
    sidecarBaseUrl,
  });

  const runPrompt = `What is the ${seedSubject}? Reply in one short sentence.`;
  await runEmbeddedPiAgent({
    sessionId: "session:live-openclaw",
    sessionKey: "agent:live-openclaw:session",
    sessionFile,
    workspaceDir: workspace.workspaceDir,
    agentDir: workspace.agentDir,
    config,
    prompt: runPrompt,
    provider: "openai",
    model: LIVE_MODEL,
    timeoutMs: 120_000,
    runId: "muninn-before-prompt-build-live",
    enqueue: fixtures.immediateEnqueue,
    disableTools: true,
  });

  const capturedRequest = proxy.lastJsonBody;
  assert.ok(capturedRequest, "expected the local proxy to capture one provider request");

  const systemText = extractProviderRoleText(capturedRequest, "system");
  const userText = extractProviderRoleText(capturedRequest, "user");

  assert.ok(
    systemText.includes("<relevant-memories>"),
    `expected provider system input to include relevant memories, got:\n${systemText}`,
  );
  assert.ok(
    systemText.includes(seededRecall),
    `expected provider system input to include the recalled memory text, got:\n${systemText}`,
  );
  assert.ok(
    userText.includes(runPrompt),
    `expected provider user input to include the raw prompt, got:\n${userText}`,
  );
  assert.equal(userText.includes("<relevant-memories>"), false);
  assert.equal(userText.includes(seededRecall), false);

  const storedTurn = await waitForStoredTurn({
    baseUrl: sidecarBaseUrl,
    prompt: runPrompt,
    sidecarOutput: () => sidecar.output,
  });
  const detailResponse = await getJson(
    `${sidecarBaseUrl}/api/v1/detail?memoryId=${encodeURIComponent(storedTurn.memoryId)}`,
  );
  const detailContent = detailResponse.memoryHits?.[0]?.content;
  assert.equal(typeof detailContent, "string");

  const promptLine = detailContent.split("\n").find((line) => line.startsWith("Prompt: "));
  assert.equal(promptLine, `Prompt: ${runPrompt}`);
  assert.equal(detailContent.includes("<relevant-memories>"), false);
});

function normalizeLiveModelApi(raw) {
  const value = raw?.trim();
  if (value === "openai-completions" || value === "chat-completions" || value === "chat_completions") {
    return "openai-completions";
  }
  return "openai-responses";
}

function normalizePositiveInteger(raw, fallback) {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createLiveOpenClawConfig({ modelId, apiKey, api, proxyBaseUrl, sidecarBaseUrl }) {
  return {
    models: {
      providers: {
        openai: {
          api,
          apiKey,
          baseUrl: `${proxyBaseUrl}/v1`,
          models: [
            {
              id: modelId,
              name: `Live ${modelId}`,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 2_048,
            },
          ],
        },
      },
    },
    plugins: {
      allow: ["muninn"],
      load: {
        paths: [pluginRoot],
      },
      entries: {
        muninn: {
          enabled: true,
          hooks: {
            allowPromptInjection: true,
          },
          config: {
            baseUrl: sidecarBaseUrl,
            timeoutMs: LIVE_PLUGIN_TIMEOUT_MS,
            recallLimit: 3,
          },
        },
      },
    },
  };
}

async function writeMuninnConfig(configPath, { sourcePath, storageUri }) {
  const config = sourcePath
    ? JSON.parse(await fs.readFile(sourcePath, "utf8"))
    : {
      observer: {
        name: "live-observer",
        llm: "default_observer_llm",
        maxAttempts: 3,
        activeWindowDays: 7,
      },
      llm: {
        default_observer_llm: {
          provider: "mock",
        },
      },
      semanticIndex: {
        embedding: {
          provider: "mock",
          dimensions: 8,
        },
        defaultImportance: 0.7,
      },
      watchdog: {
        enabled: false,
      },
    };
  config.storage = {
    ...(typeof config.storage === "object" && config.storage && !Array.isArray(config.storage)
      ? config.storage
      : {}),
    uri: storageUri,
  };

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function toFileStoreUri(dir) {
  return `file-object-store://${path.resolve(dir)}`;
}

function startSidecar({ cwd, entryPath, muninnHome, port }) {
  const child = spawn(process.execPath, [entryPath], {
    cwd,
    env: {
      ...process.env,
      MUNINN_HOME: muninnHome,
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });

  return {
    child,
    get output() {
      return output;
    },
  };
}

async function waitForSidecarHealth(baseUrl, sidecarOutput) {
  let lastError = "sidecar never became healthy";
  try {
    await waitFor(async () => {
      try {
        const response = await fetch(`${baseUrl}/health`);
        if (!response.ok) {
          lastError = `health returned ${response.status}`;
          return false;
        }
        const payload = await response.json();
        if (payload?.status === "ok") {
          return true;
        }
        lastError = `unexpected health payload: ${JSON.stringify(payload)}`;
        return false;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        return false;
      }
    }, 30_000, 100);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `sidecar did not become healthy: ${lastError || reason}\n${sidecarOutput()}`,
    );
  }
}

async function waitForSeedRecall({ baseUrl, query, expectedText, sidecarOutput }) {
  let lastWatermark = null;
  let lastRecall = null;

  try {
    await waitFor(async () => {
      lastWatermark = await getJson(`${baseUrl}/api/v1/observer/watermark`);
      if (!lastWatermark?.resolved) {
        return false;
      }
      lastRecall = await getJson(
        `${baseUrl}/api/v1/recall?query=${encodeURIComponent(query)}&limit=3`,
      );
      return Array.isArray(lastRecall?.memoryHits)
        && lastRecall.memoryHits.some((hit) => (
          typeof hit?.content === "string"
          && hit.content.includes(expectedText)
        ));
    }, LIVE_SEED_RECALL_TIMEOUT_MS, 200);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `seed recall never became available: ${reason}.\nwatermark=${JSON.stringify(lastWatermark)}\nrecall=${JSON.stringify(lastRecall)}\nsidecar=${sidecarOutput()}`,
    );
  }

  const content = lastRecall?.memoryHits?.find((hit) => (
    typeof hit?.content === "string"
    && hit.content.includes(expectedText)
  ))?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error(
      `seed recall never became available.\nwatermark=${JSON.stringify(lastWatermark)}\nrecall=${JSON.stringify(lastRecall)}\nsidecar=${sidecarOutput()}`,
    );
  }
  return content.trim();
}

async function waitForStoredTurn({ baseUrl, prompt, sidecarOutput }) {
  let lastList = null;

  await waitFor(async () => {
    lastList = await getJson(`${baseUrl}/api/v1/list?mode=recency&limit=20`);
    return Array.isArray(lastList?.memoryHits) && lastList.memoryHits.some((candidate) => (
      typeof candidate?.memoryId === "string"
      && candidate.memoryId.startsWith("session:")
      && typeof candidate?.content === "string"
      && candidate.content.includes(prompt)
    ));
  }, 15_000, 100);

  const match = lastList?.memoryHits?.find((candidate) => (
    typeof candidate?.memoryId === "string"
    && candidate.memoryId.startsWith("session:")
    && typeof candidate?.content === "string"
    && candidate.content.includes(prompt)
  ));
  if (!match) {
    throw new Error(
      `failed to find stored session turn for prompt ${JSON.stringify(prompt)}.\nlist=${JSON.stringify(lastList)}\nsidecar=${sidecarOutput()}`,
    );
  }
  return match;
}

async function startOpenAiProxy({ upstreamUrl }) {
  const port = await getFreePort();
  let lastJsonBody = null;

  const server = http.createServer(async (req, res) => {
    try {
      const body = await readRequestBody(req);
      lastJsonBody = body.length > 0 ? JSON.parse(body.toString("utf8")) : null;
      const targetUrl = resolveUpstreamRequestUrl(upstreamUrl, req.url);

      const upstreamResponse = await fetch(targetUrl, {
        method: req.method ?? "POST",
        headers: filteredForwardHeaders(req.headers),
        body: body.length > 0 ? body : undefined,
      });

      const headers = Object.fromEntries(upstreamResponse.headers.entries());
      res.writeHead(upstreamResponse.status, headers);
      if (!upstreamResponse.body) {
        res.end();
        return;
      }
      Readable.fromWeb(upstreamResponse.body).pipe(res);
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(message);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    get lastJsonBody() {
      return lastJsonBody;
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function resolveUpstreamRequestUrl(configuredUrl, requestPath) {
  const upstream = new URL(configuredUrl);
  const incoming = new URL(requestPath || "/", "http://127.0.0.1");
  if (!/\/(responses|chat\/completions)\/?$/i.test(upstream.pathname)) {
    if (/^\/v1\/?$/i.test(upstream.pathname) || upstream.pathname === "/") {
      upstream.pathname = incoming.pathname;
    } else {
      upstream.pathname = `${upstream.pathname.replace(/\/+$/, "")}${incoming.pathname}`;
    }
  }
  if (incoming.search) {
    upstream.search = incoming.search;
  }
  return upstream.toString();
}

function filteredForwardHeaders(headers) {
  const forwarded = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || key.toLowerCase() === "host") {
      continue;
    }
    forwarded[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return forwarded;
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function extractProviderRoleText(payload, role) {
  const texts = [];

  if (role === "system" && typeof payload?.instructions === "string") {
    texts.push(payload.instructions);
  }

  const items = Array.isArray(payload?.input)
    ? payload.input
    : Array.isArray(payload?.messages)
      ? payload.messages
      : [];
  for (const item of items) {
    if (!item || typeof item !== "object" || item.role !== role) {
      continue;
    }
    if (typeof item.content === "string") {
      texts.push(item.content);
      continue;
    }
    if (!Array.isArray(item.content)) {
      continue;
    }
    for (const block of item.content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      if (
        (block.type === "input_text" || block.type === "output_text" || block.type === "text")
        && typeof block.text === "string"
      ) {
        texts.push(block.text);
      }
    }
  }

  return texts.join("\n\n");
}

async function postJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`request failed ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function waitFor(predicate, timeoutMs, intervalMs) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  if (!port) {
    throw new Error("failed to allocate a free local port");
  }
  return port;
}

async function stopChildProcess(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    sleep(5_000).then(() => false),
  ]);
  if (exited || child.exitCode !== null) {
    return;
  }
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
}
