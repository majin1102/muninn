export type Artifact = {
  key: string;
  kind: "metadata" | "text" | "image" | "file";
  source: "prompt" | "response" | "tool" | "import";
  content?: string;
  uri?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
};

export type TurnEvent =
  | { type: "userMessage"; text: string; timestamp?: string; artifacts?: Artifact[] }
  | { type: "assistantMessage"; text: string; timestamp?: string; artifacts?: Artifact[] }
  | { type: "toolCall"; id?: string; name: string; input?: string; timestamp?: string }
  | { type: "toolOutput"; id?: string; output?: string; timestamp?: string; artifacts?: Artifact[] };

export type TurnContent = {
  sessionId: string;
  agent: string;
  prompt: string;
  response: string;
  events: TurnEvent[];
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
  events?: TurnEvent[];
  artifacts?: Artifact[];
}): CaptureTurnRequest | null {
  const sessionId = normalizeText(params.sessionKey);
  const agent = normalizeText(params.agentId);
  const prompt = normalizeText(params.prompt);
  const response = normalizeText(params.response);

  if (!sessionId || !agent || !prompt || !response) {
    return null;
  }

  const events = normalizeEvents(params.events, prompt, response);
  const artifacts = normalizeArtifacts(params.artifacts);

  return {
    turn: {
      sessionId,
      agent,
      prompt,
      response,
      events,
      ...(artifacts ? { artifacts } : {}),
    },
  };
}

function normalizeEvents(events: TurnEvent[] | undefined, prompt: string, response: string): TurnEvent[] {
  const normalized = (events ?? []).map(normalizeEvent).filter((event): event is TurnEvent => event !== null);
  return [
    { type: "userMessage", text: prompt },
    ...normalized,
    { type: "assistantMessage", text: response },
  ];
}

function normalizeEvent(event: TurnEvent): TurnEvent | null {
  if (event.type === "userMessage" || event.type === "assistantMessage") {
    const text = normalizeText(event.text);
    return text ? {
      type: event.type,
      text,
      ...(normalizeOptionalText(event.timestamp) ? { timestamp: normalizeOptionalText(event.timestamp) } : {}),
      ...(event.artifacts?.length ? { artifacts: normalizeArtifacts(event.artifacts) ?? [] } : {}),
    } : null;
  }
  if (event.type === "toolCall") {
    const name = normalizeText(event.name);
    return name ? {
      type: "toolCall",
      ...(normalizeOptionalText(event.id) ? { id: normalizeOptionalText(event.id) } : {}),
      name,
      ...(normalizeOptionalText(event.input) ? { input: normalizeOptionalText(event.input) } : {}),
      ...(normalizeOptionalText(event.timestamp) ? { timestamp: normalizeOptionalText(event.timestamp) } : {}),
    } : null;
  }
  if (event.type === "toolOutput") {
    return {
      type: "toolOutput",
      ...(normalizeOptionalText(event.id) ? { id: normalizeOptionalText(event.id) } : {}),
      ...(normalizeOptionalText(event.output) ? { output: normalizeOptionalText(event.output) } : {}),
      ...(normalizeOptionalText(event.timestamp) ? { timestamp: normalizeOptionalText(event.timestamp) } : {}),
      ...(event.artifacts?.length ? { artifacts: normalizeArtifacts(event.artifacts) ?? [] } : {}),
    };
  }
  return null;
}

function normalizeArtifacts(artifacts: Artifact[] | undefined): Artifact[] | undefined {
  if (!artifacts) {
    return undefined;
  }
  const normalized = artifacts
    .map((artifact) => ({
      key: normalizeText(artifact.key),
      kind: artifact.kind,
      source: artifact.source,
      ...(normalizeOptionalText(artifact.content) ? { content: normalizeOptionalText(artifact.content) } : {}),
      ...(normalizeOptionalText(artifact.uri) ? { uri: normalizeOptionalText(artifact.uri) } : {}),
      ...(normalizeOptionalText(artifact.name) ? { name: normalizeOptionalText(artifact.name) } : {}),
      ...(normalizeOptionalText(artifact.mimeType) ? { mimeType: normalizeOptionalText(artifact.mimeType) } : {}),
      ...(typeof artifact.sizeBytes === "number" && Number.isFinite(artifact.sizeBytes) ? { sizeBytes: artifact.sizeBytes } : {}),
    }))
    .filter((artifact) => artifact.key
      && ["metadata", "text", "image", "file"].includes(artifact.kind)
      && ["prompt", "response", "tool", "import"].includes(artifact.source)
      && (artifact.content || artifact.uri));
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = normalizeText(value);
  return normalized || undefined;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
