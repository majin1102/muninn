# Muninn MCP Demo

The current demo shape is:

- the sidecar stores session memory rows in the Lance-backed `turn` dataset (public memory layer `SESSION`)
- `turn/capture` writes one complete turn into a logical session
- memory APIs return `MemoryResponse`

## Core Types

```ts
export interface MemoryHit {
  memoryId: string;
  content: string;
}

export interface MemoryResponse {
  memoryHits: MemoryHit[];
  requestId: string;
}
```

## Write Shape

```ts
export interface Artifact {
  key: string;
  kind: "metadata" | "text" | "image" | "file";
  source: "prompt" | "response" | "tool" | "import";
  content?: string;
  uri?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export type TurnEvent =
  | { type: "userMessage"; text: string; timestamp?: string; artifacts?: Artifact[] }
  | { type: "assistantMessage"; text: string; timestamp?: string; artifacts?: Artifact[] }
  | { type: "toolCall"; id?: string; name: string; input?: string; timestamp?: string }
  | { type: "toolOutput"; id?: string; output?: string; timestamp?: string; artifacts?: Artifact[] };

export interface TurnContent {
  sessionId: string;
  agent: string;
  prompt: string;
  response: string;
  events: TurnEvent[];
  artifacts?: Artifact[];
}

export interface CaptureTurnRequest {
  turn: TurnContent;
}

export interface CaptureTurnResponse {
  turnId: string;
  requestId: string;
}
```

The HTTP path is `POST /api/v1/turn/capture`. `sessionId`, `agent`, `prompt`, `response`, and `events` are required. `artifacts` is optional.
