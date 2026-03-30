export type SessionMessageInput = {
  session_id?: string;
  agent: string;
  title?: string;
  summary?: string;
  tool_calling?: string[];
  artifacts?: Record<string, string>;
  prompt?: string;
  response?: string;
  extra?: Record<string, string>;
};

export type AddMessageToSessionRequest = {
  session: SessionMessageInput;
};

export function buildPromptPayload(params: {
  sessionKey?: string;
  agentId?: string;
  prompt: string;
}): AddMessageToSessionRequest | null {
  const prompt = normalizeText(params.prompt);
  if (!params.agentId || !prompt) {
    return null;
  }
  return {
    session: {
      session_id: normalizeOptionalText(params.sessionKey),
      agent: params.agentId,
      prompt,
    },
  };
}

export function buildToolPayload(params: {
  sessionKey?: string;
  agentId?: string;
  command: string;
  artifacts?: Record<string, string>;
}): AddMessageToSessionRequest | null {
  const command = normalizeText(params.command);
  if (!params.agentId || !command) {
    return null;
  }
  const artifacts = normalizeArtifacts(params.artifacts);
  return {
    session: {
      session_id: normalizeOptionalText(params.sessionKey),
      agent: params.agentId,
      tool_calling: [command],
      ...(artifacts ? { artifacts } : {}),
    },
  };
}

export function buildResponsePayload(params: {
  sessionKey?: string;
  agentId?: string;
  response: string;
}): AddMessageToSessionRequest | null {
  const response = normalizeText(params.response);
  if (!params.agentId || !response) {
    return null;
  }
  return {
    session: {
      session_id: normalizeOptionalText(params.sessionKey),
      agent: params.agentId,
      response,
    },
  };
}

function normalizeArtifacts(
  artifacts: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!artifacts) {
    return undefined;
  }
  const entries = Object.entries(artifacts)
    .map(([key, value]) => [normalizeText(key), normalizeText(value)] as const)
    .filter(([key, value]) => key && value);
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = normalizeText(value);
  return normalized || undefined;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
