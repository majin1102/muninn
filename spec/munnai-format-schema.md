# Munnai Format Schema Spec（当前 Demo 对齐版）

本文档描述当前 demo 的数据结构约定。文档保留 schema/spec 的组织方式，但内容以当前 TS/JS demo 的接口和术语为准。

## 1. 概览

当前 demo 主要围绕单条 turn 数据展开：

- 写入侧通过 `message/add` 写入 turn
- 读侧通过 `memoryId` 读取 `MemoryHit[]`
- session 聚合与 thinking 写入尚未进入当前 demo 的正式接口

## 2. IDs 与标识

当前文档约定：

- 读侧统一使用 `memoryId`
- 单条持久化的 turn 标识记为 `turnId`

## 3. 当前写入类型

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

export interface AddTurnRequest {
  turn: Turn;
}

export interface AddTurnResponse {
  turnId: string;
  requestId: string;
}
```

当前 HTTP 路径仍为 `POST /api/v1/message/add`，但请求体语义统一为 `{ turn: Turn }`。

## 4. 当前持久化记录（概念层）

```ts
export interface StoredTurn {
  turnId: string;
  agent: string;
  summary?: string;
  details?: string;
  tool_calling?: string[];
  // 工具调用过程中产生的产出物。
  artifacts?: Record<string, string>;
  prompt?: string;
  response?: string;
  createdAt: string;
}
```

## 5. 当前读侧类型

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

## 6. 当前范围边界

当前 demo 不把以下内容作为正式 schema 承诺：

- session 写入 schema
- thinking 写入 schema
- embedding 写入字段
- 自动 session 聚合后的持久化 schema
