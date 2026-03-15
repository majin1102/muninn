# Munnai 当前接口梳理

本文档用于汇总当前 TS/JS demo 的实际接口，方便与其它文档交叉检查。

## 1. 当前 MCP tools

- `print`
- `recall`
- `list`
- `get_timeline`
- `get_detail`

## 2. 当前 sidecar 写接口

- `POST /api/v1/message/add`

写入类型：

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
```

## 3. 当前 sidecar 读接口

- `GET /api/v1/recall`
- `GET /api/v1/list`
- `GET /api/v1/timeline`
- `GET /api/v1/detail`

共享响应：

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

## 4. 当前标识术语

- 读接口：`memoryId`
- 文档术语：`turnId`
- 单条 message-turn 的持久化标识统一表述为 `turnId`
