import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { pluginRoot as MUNINN_PLUGIN_ROOT, resolveOpenClawRoot } from "../helpers/paths.mjs";

const OPENCLAW_ROOT = resolveOpenClawRoot();

const openclawModulePath = (...segments) => path.join(OPENCLAW_ROOT, ...segments);
const openclawModuleUrl = (...segments) => pathToFileURL(openclawModulePath(...segments));
const mockModule = (t, specifier, options) => {
  try {
    t.mock.module(specifier, options);
  } catch (error) {
    if (error?.code !== "ERR_INVALID_STATE") {
      throw error;
    }
  }
};
const mockOpenClawModule = (t, relativePath, namedExports) => {
  const tsUrl = openclawModuleUrl(relativePath);
  mockModule(t, tsUrl, { namedExports });
  if (relativePath.endsWith(".ts")) {
    mockModule(t, openclawModuleUrl(relativePath.replace(/\.ts$/, ".js")), { namedExports });
  }
};

test("injects recall into system prompt and keeps captured turn prompt clean", async (t) => {
  const observedModelContexts = [];
  const fetchCalls = [];
  const captureBodies = [];
  let modelResolveCalls = 0;
  let contextEngineResolveCalls = 0;
  let contextEngineAssembleCalls = 0;
  let attemptBootstrapCalls = 0;
  let sessionLockCalls = 0;
  let lspRuntimeCalls = 0;
  let systemPromptBuildCalls = 0;
  let systemPromptReportCalls = 0;
  let sessionRepairCalls = 0;
  let transcriptPolicyCalls = 0;
  let sessionPrewarmCalls = 0;
  let sessionManagerOpenCalls = 0;
  let sessionPrepareCalls = 0;
  let agentSessionCreateCalls = 0;

  const piAiModuleUrl = openclawModuleUrl("node_modules/@mariozechner/pi-ai/dist/index.js");
  const actualPiAi = await import(piAiModuleUrl.href);
  const piCodingAgentModuleUrl = openclawModuleUrl(
    "node_modules/@mariozechner/pi-coding-agent/dist/index.js",
  );

  const buildAssistant = (model) => ({
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    stopReason: "stop",
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
  });

  const recordContext = (context) => {
    if (!context || typeof context !== "object") {
      observedModelContexts.push({});
      return;
    }
    observedModelContexts.push({
      systemPrompt: typeof context.systemPrompt === "string" ? context.systemPrompt : undefined,
      messages: Array.isArray(context.messages) ? context.messages : undefined,
    });
  };

  const piAiMock = {
    namedExports: {
      ...actualPiAi,
      complete: async (model, context) => {
        recordContext(context);
        return buildAssistant(model);
      },
      completeSimple: async (model, context) => {
        recordContext(context);
        return buildAssistant(model);
      },
      streamSimple: (model, context) => {
        recordContext(context);
        const stream = actualPiAi.createAssistantMessageEventStream();
        queueMicrotask(() => {
          const message = buildAssistant(model);
          stream.push({ type: "start", partial: message });
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: "ok", partial: message });
          stream.push({
            type: "done",
            reason: "stop",
            message,
          });
          stream.end();
        });
        return stream;
      },
      stream: (model, context) => {
        recordContext(context);
        const stream = actualPiAi.createAssistantMessageEventStream();
        queueMicrotask(() => {
          const message = buildAssistant(model);
          stream.push({ type: "start", partial: message });
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: "ok", partial: message });
          stream.push({
            type: "done",
            reason: "stop",
            message,
          });
          stream.end();
        });
        return stream;
      },
    },
  };
  mockModule(t, "@mariozechner/pi-ai", piAiMock);
  mockModule(t, piAiModuleUrl, piAiMock);

  class FakeSessionManager {
    static open(sessionFile) {
      sessionManagerOpenCalls += 1;
      return new FakeSessionManager(sessionFile);
    }

    constructor(sessionFile) {
      this.sessionFile = sessionFile;
      this.messages = [];
    }

    appendCustomEntry() {}
    branch() {}
    buildSessionContext() {
      return { messages: this.messages };
    }
    getLeafEntry() {
      return null;
    }
    resetLeaf() {}
  }

  class FakeResourceLoader {
    async reload() {}
  }

  class FakeSettingsManager {
    getCompactionReserveTokens() {
      return 0;
    }
    getGlobalSettings() {
      return {};
    }
    getProjectSettings() {
      return {};
    }
  }

  const createFakeAgentSession = async ({ model, sessionManager }) => {
    agentSessionCreateCalls += 1;
    const state = {
      messages: sessionManager?.messages ?? [],
      systemPrompt: "",
    };
    const session = {
      agent: {
        state,
        streamFn: piAiMock.namedExports.streamSimple,
      },
      get messages() {
        return state.messages;
      },
      isCompacting: false,
      isStreaming: false,
      sessionId: "session:test",
      abort: async () => undefined,
      prompt: async (prompt) => {
        state.messages.push({
          role: "user",
          content: [{ type: "text", text: prompt }],
        });
        const stream = session.agent.streamFn(model, {
          systemPrompt: state.systemPrompt,
          messages: state.messages,
        });
        const assistant = await stream.result();
        state.messages.push(assistant);
        await fs.writeFile(
          sessionManager.sessionFile,
          `${state.messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
          "utf8",
        );
        return assistant;
      },
      steer: async () => undefined,
    };
    return { session };
  };

  const piCodingAgentMock = {
    namedExports: {
      codingTools: [],
      CURRENT_SESSION_VERSION: 1,
      createAgentSession: createFakeAgentSession,
      createBashTool: () => ({ name: "bash" }),
      createEditTool: () => ({ name: "edit" }),
      createFindTool: () => ({ name: "find" }),
      createGrepTool: () => ({ name: "grep" }),
      createLsTool: () => ({ name: "ls" }),
      createReadOnlyTools: () => [],
      createReadTool: () => ({ name: "read" }),
      createWriteTool: () => ({ name: "write" }),
      DefaultResourceLoader: FakeResourceLoader,
      estimateTokens: (value) => Math.ceil(String(value ?? "").length / 4),
      generateSummary: async () => "summary",
      readOnlyTools: [],
      readTool: { name: "read" },
      SettingsManager: FakeSettingsManager,
      SessionManager: FakeSessionManager,
    },
  };
  mockModule(t, "@mariozechner/pi-coding-agent", piCodingAgentMock);
  mockModule(t, piCodingAgentModuleUrl, piCodingAgentMock);

  mockOpenClawModule(t, "src/context-engine/init.ts", {
    ensureContextEnginesInitialized: async () => undefined,
  });
  mockOpenClawModule(t, "src/context-engine/registry.ts", {
    registerContextEngine: () => undefined,
    registerContextEngineForOwner: () => undefined,
    resolveContextEngine: async () => {
      contextEngineResolveCalls += 1;
      return {
        info: { id: "legacy", name: "Legacy" },
        ingest: async () => ({ ingested: false }),
        assemble: async (params) => {
          contextEngineAssembleCalls += 1;
          return {
            messages: params.messages,
            estimatedTokens: 0,
          };
        },
        compact: async () => ({ ok: true, compacted: false }),
        afterTurn: async () => undefined,
        dispose: async () => undefined,
      };
    },
  });
  mockOpenClawModule(t, "src/agents/runtime-plugins.ts", {
    ensureRuntimePluginsLoaded: () => undefined,
  });
  mockOpenClawModule(t, "src/agents/models-config.ts", {
    ensureOpenClawModelsJson: async () => ({ wrote: false }),
  });
  mockOpenClawModule(t, "src/agents/pi-bundle-mcp-tools.ts", {
    disposeSessionMcpRuntime: async () => undefined,
    getOrCreateSessionMcpRuntime: async () => undefined,
    materializeBundleMcpToolsForRun: async () => undefined,
  });
  mockOpenClawModule(t, "src/agents/pi-bundle-lsp-runtime.ts", {
    createBundleLspToolRuntime: async () => {
      lspRuntimeCalls += 1;
      return undefined;
    },
  });
  mockOpenClawModule(t, "src/agents/docs-path.ts", {
    resolveOpenClawDocsPath: async () => undefined,
  });
  mockOpenClawModule(t, "src/infra/machine-name.ts", {
    getMachineDisplayName: async () => "test-host",
  });
  mockOpenClawModule(t, "src/agents/system-prompt-params.ts", {
    buildSystemPromptParams: ({ runtime }) => ({
      runtimeInfo: runtime,
      userTimezone: "UTC",
      userTime: "2024-01-01 00:00",
      userTimeFormat: "datetime",
    }),
  });
  mockOpenClawModule(t, "src/agents/pi-embedded-runner/system-prompt.ts", {
    applySystemPromptOverrideToSession: (session, override) => {
      const prompt = typeof override === "function" ? override() : String(override ?? "").trim();
      session.agent.state.systemPrompt = prompt;
    },
    buildEmbeddedSystemPrompt: () => {
      systemPromptBuildCalls += 1;
      return "base system prompt";
    },
    createSystemPromptOverride: (systemPrompt) => () => systemPrompt.trim(),
  });
  mockOpenClawModule(t, "src/agents/pi-embedded-runner/run/attempt.context-engine-helpers.ts", {
    assembleAttemptContextEngine: async (params) => {
      contextEngineAssembleCalls += 1;
      return params.contextEngine?.assemble({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        messages: params.messages,
        model: params.modelId,
        prompt: params.prompt,
      });
    },
    buildContextEnginePromptCacheInfo: () => undefined,
    finalizeAttemptContextEngineTurn: async () => ({ postTurnFinalizationSucceeded: true }),
    findCurrentAttemptAssistantMessage: ({ messagesSnapshot, prePromptMessageCount }) =>
      messagesSnapshot
        .slice(Math.max(0, prePromptMessageCount))
        .reverse()
        .find((message) => message?.role === "assistant"),
    resolveAttemptBootstrapContext: async () => {
      attemptBootstrapCalls += 1;
      return {
        bootstrapFiles: [],
        contextFiles: [],
        isContinuationTurn: false,
        shouldRecordCompletedBootstrapTurn: false,
      };
    },
    runAttemptContextEngineBootstrap: async () => undefined,
  });
  mockOpenClawModule(t, "src/agents/pi-embedded-runner/model.ts", {
    resolveModelAsync: async (provider, modelId) => {
      modelResolveCalls += 1;
      return {
        model: {
          id: modelId,
          name: modelId,
          api: "openai-responses",
          provider,
          baseUrl: `https://example.com/${provider}`,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 16_000,
          maxTokens: 2048,
        },
        error: undefined,
        authStorage: {
          setRuntimeApiKey: () => undefined,
        },
        modelRegistry: {},
      };
    },
  });
  mockOpenClawModule(t, "src/agents/pi-embedded-runner/run/auth-controller.ts", {
    createEmbeddedRunAuthController: () => ({
      advanceAuthProfile: async () => false,
      initializeAuthProfile: async () => undefined,
      maybeRefreshRuntimeAuthForAuthError: async () => false,
      stopRuntimeAuthRefreshTimer: () => undefined,
    }),
  });
  mockOpenClawModule(t, "src/agents/session-write-lock.ts", {
    __testing: {},
    acquireSessionWriteLock: async () => {
      sessionLockCalls += 1;
      return {
        release: async () => undefined,
      };
    },
    cleanStaleLockFiles: async () => undefined,
    drainSessionWriteLockStateForTest: async () => undefined,
    resetSessionWriteLockStateForTest: () => undefined,
    resolveSessionLockMaxHoldFromTimeout: ({ timeoutMs }) => timeoutMs,
  });
  mockOpenClawModule(t, "src/agents/pi-embedded-runner/session-manager-cache.ts", {
    prewarmSessionFile: async () => {
      sessionPrewarmCalls += 1;
    },
    trackSessionManagerAccess: () => undefined,
  });
  mockOpenClawModule(t, "src/agents/pi-embedded-runner/session-manager-init.ts", {
    prepareSessionManagerForRun: async () => {
      sessionPrepareCalls += 1;
    },
  });
  mockOpenClawModule(t, "src/agents/pi-project-settings.ts", {
    createPreparedEmbeddedPiSettingsManager: () => new FakeSettingsManager(),
  });
  mockOpenClawModule(t, "src/agents/pi-embedded-runner/extensions.ts", {
    buildEmbeddedExtensionFactories: () => [],
  });
  mockOpenClawModule(t, "src/agents/pi-settings.ts", {
    applyPiAutoCompactionGuard: () => undefined,
  });
  mockOpenClawModule(t, "src/agents/session-file-repair.ts", {
    repairSessionFileIfNeeded: async () => {
      sessionRepairCalls += 1;
    },
  });
  mockOpenClawModule(t, "src/agents/session-tool-result-guard-wrapper.ts", {
    guardSessionManager: (sessionManager) => sessionManager,
  });
  mockOpenClawModule(t, "src/agents/system-prompt-report.ts", {
    buildSystemPromptReport: () => {
      systemPromptReportCalls += 1;
      return undefined;
    },
  });
  mockOpenClawModule(t, "src/agents/transcript-policy.ts", {
    resolveTranscriptPolicy: () => {
      transcriptPolicyCalls += 1;
      return {
        allowSyntheticToolResults: true,
        preserveNativeAnthropicToolUseIds: false,
        preserveNativeGoogleThinking: false,
        preserveNativeOpenAIReasoning: false,
        preserveNativeOpenAIToolCallIds: false,
        preserveReplaySafeThinkingToolCallIds: false,
      };
    },
    shouldAllowProviderOwnedThinkingReplay: () => false,
  });
  mockOpenClawModule(t, "src/logging/subsystem.ts", {
    createSubsystemLogger: () => ({
      child: () => ({
        debug: () => undefined,
        error: () => undefined,
        info: () => undefined,
        isEnabled: () => false,
        trace: () => undefined,
        warn: () => undefined,
      }),
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      isEnabled: () => false,
      trace: () => undefined,
      warn: () => undefined,
    }),
    createSubsystemRuntime: () => ({}),
    runtimeForLogger: () => ({}),
    stripRedundantSubsystemPrefixForConsole: (value) => value,
  });
  mockOpenClawModule(t, "src/plugins/provider-runtime.ts", {
    __testing: {},
    applyProviderConfigDefaultsWithPlugin: () => undefined,
    applyProviderNativeStreamingUsageCompatWithPlugin: () => undefined,
    applyProviderResolvedModelCompatWithPlugins: () => undefined,
    applyProviderResolvedTransportWithPlugin: () => undefined,
    buildProviderAuthDoctorHintWithPlugin: async () => undefined,
    buildProviderMissingAuthMessageWithPlugin: () => undefined,
    buildProviderUnknownModelHintWithPlugin: () => undefined,
    clearProviderRuntimeHookCache: () => undefined,
    createProviderEmbeddingProvider: async () => undefined,
    formatProviderAuthProfileApiKeyWithPlugin: () => undefined,
    inspectProviderToolSchemasWithPlugin: () => undefined,
    matchesProviderContextOverflowWithPlugin: () => false,
    normalizeProviderConfigWithPlugin: () => undefined,
    normalizeProviderModelIdWithPlugin: () => undefined,
    normalizeProviderResolvedModelWithPlugin: ({ context }) => context.model,
    normalizeProviderToolSchemasWithPlugin: () => undefined,
    normalizeProviderTransportWithPlugin: () => undefined,
    prepareProviderDynamicModel: async () => undefined,
    prepareProviderExtraParams: () => undefined,
    prepareProviderRuntimeAuth: async () => undefined,
    refreshProviderOAuthCredentialWithPlugin: async () => undefined,
    resetProviderRuntimeHookCacheForTest: () => undefined,
    resolveExternalOAuthProfilesWithPlugins: () => [],
    resolveExternalAuthProfilesWithPlugins: () => [],
    resolveProviderBinaryThinking: () => undefined,
    resolveProviderBuiltInModelSuppression: () => undefined,
    resolveProviderCacheTtlEligibility: () => undefined,
    resolveProviderConfigApiKeyWithPlugin: () => undefined,
    resolveProviderDefaultThinkingLevel: () => undefined,
    resolveProviderModernModelRef: () => undefined,
    resolveProviderReasoningOutputModeWithPlugin: () => undefined,
    resolveProviderReplayPolicyWithPlugin: () => undefined,
    resolveProviderRuntimePlugin: () => undefined,
    resolveProviderStreamFn: () => undefined,
    resolveProviderSyntheticAuthWithPlugin: () => undefined,
    resolveProviderSystemPromptContribution: () => undefined,
    resolveProviderTextTransforms: () => undefined,
    resolveProviderTransportTurnStateWithPlugin: () => undefined,
    resolveProviderUsageAuthWithPlugin: async () => undefined,
    resolveProviderUsageSnapshotWithPlugin: async () => undefined,
    resolveProviderWebSocketSessionPolicyWithPlugin: () => undefined,
    resolveProviderXHighThinking: () => undefined,
    runProviderDynamicModel: () => undefined,
    sanitizeProviderReplayHistoryWithPlugin: async () => undefined,
    shouldDeferProviderSyntheticProfileAuthWithPlugin: () => undefined,
    shouldPreferProviderRuntimeResolvedModel: () => false,
    transformProviderSystemPrompt: ({ context }) => context.systemPrompt,
    validateProviderReplayTurnsWithPlugin: async () => undefined,
    wrapProviderStreamFn: () => undefined,
  });

  const { runEmbeddedPiAgent } = await import(
    openclawModuleUrl("src/agents/pi-embedded-runner/run.ts").href
  );
  const { initializeGlobalHookRunner, resetGlobalHookRunner } = await import(
    openclawModuleUrl("src/plugins/hook-runner-global.ts").href
  );
  const { createMockPluginRegistry } = await import(
    openclawModuleUrl("src/plugins/hooks.test-helpers.ts").href
  );
  const fixtures = await import(
    openclawModuleUrl("src/agents/test-helpers/pi-embedded-runner-e2e-fixtures.ts").href
  );
  const { registerMuninnHooks } = await import(
    pathToFileURL(path.join(MUNINN_PLUGIN_ROOT, "dist/src/hooks.js")).href
  );

  const workspace = await fixtures.createEmbeddedPiRunnerTestWorkspace(
    "muninn-before-prompt-build-runtime-",
  );
  const sessionFile = path.join(workspace.workspaceDir, "session.jsonl");
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    fetchCalls.push(url);
    if (url.startsWith("http://muninn.test/api/v1/recall")) {
      return new Response(
        JSON.stringify({
          memoryHits: [{ content: "remembered design note" }],
        }),
        { status: 200 },
      );
    }
    if (url === "http://muninn.test/api/v1/turn/capture") {
      captureBodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response("", { status: 204 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  t.after(async () => {
    globalThis.fetch = originalFetch;
    resetGlobalHookRunner();
    await fixtures.cleanupEmbeddedPiRunnerTestWorkspace(workspace);
  });

  const registry = createMockPluginRegistry([]);
  registerMuninnHooks({
    pluginConfig: {
      enabled: true,
      baseUrl: "http://muninn.test",
      timeoutMs: 1_000,
      recallLimit: 3,
    },
    logger: {},
    on(name, handler) {
      registry.typedHooks.push({
        pluginId: "muninn",
        hookName: name,
        handler,
        priority: 0,
        source: "test",
      });
    },
  });
  initializeGlobalHookRunner(registry);

  const config = fixtures.createEmbeddedPiRunnerOpenAiConfig(["mock-1"]);
  await withTimeout(
    runEmbeddedPiAgent({
      sessionId: "session:test",
      sessionKey: "agent:test:session",
      sessionFile,
      workspaceDir: workspace.workspaceDir,
      agentDir: workspace.agentDir,
      config,
      prompt: "what did we decide yesterday?",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      runId: "muninn-before-prompt-build-runtime",
      enqueue: fixtures.immediateEnqueue,
      disableTools: true,
      skillsSnapshot: {
        prompt: "",
        skills: [],
        resolvedSkills: [],
      },
    }),
    8_000,
    () => ({
      fetchCalls,
      modelResolveCalls,
      contextEngineResolveCalls,
      contextEngineAssembleCalls,
      attemptBootstrapCalls,
      sessionLockCalls,
      lspRuntimeCalls,
      systemPromptBuildCalls,
      systemPromptReportCalls,
      sessionRepairCalls,
      transcriptPolicyCalls,
      sessionPrewarmCalls,
      sessionManagerOpenCalls,
      sessionPrepareCalls,
      agentSessionCreateCalls,
      observedModelContexts: observedModelContexts.length,
      captureBodies: captureBodies.length,
    }),
  );

  await waitFor(() => captureBodies.length > 0);

  assert.equal(
    fetchCalls.some((url) =>
      /\/api\/v1\/recall\?query=what\+did\+we\+decide\+yesterday%3F&limit=3$/.test(url),
    ),
    true,
  );
  assert.ok(observedModelContexts.length > 0);
  assert.match(observedModelContexts[0]?.systemPrompt ?? "", /<relevant-memories>/);
  assert.match(observedModelContexts[0]?.systemPrompt ?? "", /remembered design note/);

  const lastUserMessage = observedModelContexts[0]?.messages
    ?.slice()
    .reverse()
    .find((message) => message?.role === "user");
  assert.equal(extractText(lastUserMessage?.content), "what did we decide yesterday?");

  assert.deepEqual(captureBodies[0]?.turn?.sessionId, "agent:test:session");
  assert.deepEqual(captureBodies[0]?.turn?.agent, "main");
  assert.deepEqual(captureBodies[0]?.turn?.prompt, "what did we decide yesterday?");
  assert.deepEqual(captureBodies[0]?.turn?.response, "ok");
  assert.equal(JSON.stringify(captureBodies[0]).includes("remembered design note"), false);

  const sessionRaw = await fs.readFile(sessionFile, "utf8");
  assert.equal(sessionRaw.includes("remembered design note"), false);
});

async function waitFor(predicate, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for async side effect");
}

async function withTimeout(promise, timeoutMs, diagnostics) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`timed out waiting for runEmbeddedPiAgent: ${JSON.stringify(diagnostics())}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function extractText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      return block.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("\n\n");
}
