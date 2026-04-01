# Muninn MCP Demo

The current demo shape is:

- the sidecar stores session memory rows in the Lance-backed `turn` dataset (public memory layer `SESSION`)
- `session/messages` adds a single message into a logical session
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
export interface SessionMessageInput {
  session_id?: string;
  agent: string;
  title?: string;
  summary?: string;
  tool_calling?: string[];
  // Artifacts produced by tool calls in this session memory row.
  artifacts?: Record<string, string>;
  prompt?: string;
  response?: string;
  // Free-form API-layer extra input.
  extra?: Record<string, string>;
}

export interface AddMessageToSessionRequest {
  session: SessionMessageInput;
}

export interface AddMessageToSessionResponse {
  turnId: string;
  requestId: string;
}
```

The HTTP path is `POST /api/v1/session/messages`. `agent` is required, the other message fields are optional, and at least one persisted message field must be present. `extra` is API-layer input and is not persisted.
