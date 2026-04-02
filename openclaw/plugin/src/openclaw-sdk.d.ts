declare module "openclaw/plugin-sdk/core" {
  export type PluginLogger = {
    debug?: (message: string) => void;
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };

  export type PluginHookAgentContext = {
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    workspaceDir?: string;
  };

  export type PluginHookBeforeModelResolveEvent = {
    prompt: string;
  };

  export type PluginHookAfterToolCallEvent = {
    toolName: string;
    params: Record<string, unknown>;
    runId?: string;
    toolCallId?: string;
    result?: unknown;
    error?: string;
    durationMs?: number;
  };

  export type PluginHookAgentEndEvent = {
    messages: unknown[];
    success: boolean;
    error?: string;
    durationMs?: number;
  };

  export type AgentMessage = {
    role?: string;
    content?: unknown;
  };

  export type ContextEngineInfo = {
    id: string;
    name: string;
    version?: string;
  };

  export type AssembleResult = {
    messages: AgentMessage[];
    estimatedTokens: number;
    systemPromptAddition?: string;
  };

  export type IngestResult = {
    ingested: boolean;
  };

  export type CompactResult = {
    ok: boolean;
    compacted: boolean;
    reason?: string;
  };

  export type ContextEngine = {
    info: ContextEngineInfo;
    ingest: (params: {
      sessionId: string;
      message: AgentMessage;
    }) => Promise<IngestResult>;
    afterTurn?: (params: {
      sessionId: string;
      sessionFile: string;
      messages: AgentMessage[];
      prePromptMessageCount: number;
      runtimeContext?: Record<string, unknown>;
    }) => Promise<void>;
    assemble: (params: {
      sessionId: string;
      messages: AgentMessage[];
      tokenBudget?: number;
    }) => Promise<AssembleResult>;
    compact: (params: {
      sessionId: string;
      sessionFile: string;
      tokenBudget?: number;
    }) => Promise<CompactResult>;
  };

  export type OpenClawPluginApi = {
    pluginConfig?: Record<string, unknown>;
    logger: PluginLogger;
    on: {
      (
        hookName: "before_model_resolve",
        handler: (
          event: PluginHookBeforeModelResolveEvent,
          ctx: PluginHookAgentContext,
        ) => Promise<void> | void,
      ): void;
      (
        hookName: "after_tool_call",
        handler: (
          event: PluginHookAfterToolCallEvent,
          ctx: PluginHookAgentContext,
        ) => Promise<void> | void,
      ): void;
      (
        hookName: "agent_end",
        handler: (
          event: PluginHookAgentEndEvent,
          ctx: PluginHookAgentContext,
        ) => Promise<void> | void,
      ): void;
    };
    registerContextEngine?: (id: string, factory: () => ContextEngine) => void;
  };

  export function definePluginEntry(params: {
    id: string;
    name: string;
    description: string;
    kind?: string;
    register: (api: OpenClawPluginApi) => void;
  }): unknown;
}
