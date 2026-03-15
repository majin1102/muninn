# MCP Demo (Current)

This package contains the current MCP demo for Munnai.

## Tools

The MCP server currently exposes these tools:

- `print`
  - Debug tool.
  - Prints arguments to stderr.
  - Writes a Markdown debug snapshot under `.munnai/debug/`.
- `recall`
  - Input:
    - `query: string`
    - `limit?: number`
    - `thinkingRatio?: number`
- `list`
  - Input:
    - `mode: "recency"`
    - `limit?: number`
    - `thinkingRatio?: number`
- `get_timeline`
  - Input:
    - `memoryId: string`
    - `beforeLimit?: number`
    - `afterLimit?: number`
- `get_detail`
  - Input:
    - `memoryId: string`

## Current behavior

- `print` is local-debug oriented.
- `recall`, `list`, `get_timeline`, and `get_detail` call the sidecar HTTP API.
- The sidecar currently stores turn-like message records locally and returns `MemoryResponse`.

## Current shared response shape

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

## Current write path

The current sidecar write API is:

```http
POST /api/v1/message/add
```

With:

```ts
export interface Message {
  agent: string;
  summary?: string;
  details?: string;
  trace?: string[];
  artifacts?: Record<string, string>;
  prompt?: string;
  response?: string;
}

export interface AddMessageRequest {
  message: Message;
}

export interface AddMessageResponse {
  turnId: string;
  requestId: string;
}
```

## How to run

From the repo root:

```bash
pnpm --filter @munnai/mcp-server demo
```

The demo client currently exercises `print`, and the server will generate a Markdown debug file.
