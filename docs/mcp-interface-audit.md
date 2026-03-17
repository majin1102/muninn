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
export interface Turn {
  agent: string;
  summary?: string;
  details?: string;
  tool_calling?: string[];
  // 工具调用过程中产生的产出物。
  artifacts?: Record<string, string>;
  prompt?: string;
  response?: string;
}
```

说明：

- 当前接口路径仍为 `POST /api/v1/message/add`
- 文档语义统一改为 turn
- `tool_calling` 表示本轮调用过的工具
- `artifacts` 表示工具调用产生的产出物

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
- 单条 turn 的持久化标识统一表述为 `turnId`
