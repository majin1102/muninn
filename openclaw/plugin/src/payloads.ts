export type ToolCall = {
  id?: string;
  name: string;
  input?: string;
  output?: string;
};

export type Artifact = {
  key: string;
  content: string;
};

export type TurnContent = {
  sessionId: string;
  agent: string;
  prompt: string;
  response: string;
  toolCalls?: ToolCall[];
  artifacts?: Artifact[];
};

export type CaptureTurnRequest = {
  turn: TurnContent;
};

export function buildCapturePayload(params: {
  sessionKey?: string;
  agentId?: string;
  prompt: string;
  response: string;
  toolCalls?: ToolCall[];
  artifacts?: Artifact[];
}): CaptureTurnRequest | null {
  const sessionId = normalizeText(params.sessionKey);
  const agent = normalizeText(params.agentId);
  const prompt = normalizeText(params.prompt);
  const response = normalizeText(params.response);

  if (!sessionId || !agent || !prompt || !response) {
    return null;
  }

  const toolCalls = normalizeToolCalls(params.toolCalls);
  const artifacts = normalizeArtifacts(params.artifacts);

  return {
    turn: {
      sessionId,
      agent,
      prompt,
      response,
      ...(toolCalls ? { toolCalls } : {}),
      ...(artifacts ? { artifacts } : {}),
    },
  };
}

function normalizeToolCalls(toolCalls: ToolCall[] | undefined): ToolCall[] | undefined {
  if (!toolCalls) {
    return undefined;
  }
  const normalized = toolCalls
    .map((toolCall) => ({
      ...(normalizeOptionalText(toolCall.id) ? { id: normalizeOptionalText(toolCall.id) } : {}),
      name: normalizeText(toolCall.name),
      ...(normalizeOptionalText(toolCall.input) ? { input: normalizeOptionalText(toolCall.input) } : {}),
      ...(normalizeOptionalText(toolCall.output) ? { output: normalizeOptionalText(toolCall.output) } : {}),
    }))
    .filter((toolCall) => toolCall.name);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeArtifacts(artifacts: Artifact[] | undefined): Artifact[] | undefined {
  if (!artifacts) {
    return undefined;
  }
  const normalized = artifacts
    .map((artifact) => ({
      key: normalizeText(artifact.key),
      content: normalizeText(artifact.content),
    }))
    .filter((artifact) => artifact.key && artifact.content);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = normalizeText(value);
  return normalized || undefined;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
