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
export interface ToolCall {
  id?: string;
  name: string;
  input?: string;
  output?: string;
}

export interface Artifact {
  key: string;
  content: string;
}

export interface TurnContent {
  sessionId: string;
  agent: string;
  prompt: string;
  response: string;
  toolCalls?: ToolCall[];
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

The HTTP path is `POST /api/v1/turn/capture`. `sessionId`, `agent`, `prompt`, and `response` are required. `toolCalls` and `artifacts` are optional.
