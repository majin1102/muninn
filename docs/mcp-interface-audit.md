# Muninn 当前接口梳理

本文档用于汇总当前接口与术语，方便与其它文档交叉检查。

## 1. 当前 MCP tools

- `print`
- `recall`
- `list`
- `get_timeline`
- `get_detail`

## 2. 当前 sidecar 写接口

- `POST /api/v1/session/messages`

写入对象的 format 语义：

```ts
export interface SessionMessageInput {
  session_id?: string;
  agent: string;
  title?: string;
  summary?: string;
  tool_calling?: string[];
  artifacts?: Record<string, string>;
  prompt?: string;
  response?: string;
  extra?: Record<string, string>;
}
```

说明：

- 当前接口路径为 `POST /api/v1/session/messages`
- 对外语义统一为“给某个 session 添加一条 message”
- `agent` 必填，其它 message 字段可选，但至少要有一项 message 内容
- `tool_calling` 表示本轮调用过的工具
- `artifacts` 表示工具调用产生的产出物
- `extra` 表示接口层可接受的自由附带字符串键值
- `extra` 仅用于接口传输层，sidecar 可读取它做必要处理，但不会写入持久化 format

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
- 文档术语：`sessionId`
- public memory id 统一表述为 `memoryId = {memoryLayer}:{memoryPoint}`
- 当前 session memory row 的 public memory id 为 `SESSION:{turn_id}`
- 可选分组键：`session_id`
- 长期格式方向：`memory_id = {memory_layer}:{memory_point}`
