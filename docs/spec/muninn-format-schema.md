# Muninn Format Schema Spec

本文档描述 Muninn 当前代码中的核心 format 对象、标识语义和持久化约定。

## 1. Current Persisted Units

当前已经落地的持久化 memory rows 有两类：

- `turn`
  - 一行表示一个完成或进行中的 turn row
  - `session_id` 是逻辑分组键，不是 row 主键
- `observing`
  - 一行表示一个 observing snapshot row
  - `observing_id` 是 observing line 的稳定分组键，不是 row 主键

当前尚未正式落地：

- `thinking`
- `session` 作为独立持久化 row type

## 2. Memory Layers And Identity

### 2.1 `memoryLayer` / `memory_layer`

对外 contract 使用 camelCase 概念名：

- `memoryId = {memoryLayer}:{memoryPoint}`

Rust 内部继续使用 snake_case：

- `memory_id`
- `memory_layer`
- `memory_point`

当前统一的 memory layer 枚举为：

- `THINKING`
- `OBSERVING`
- `SESSION`

其中当前正式有持久化 row 语义的是：

- `SESSION`
- `OBSERVING`

### 2.2 `memoryId` / `memory_id`

统一对外导航键为：

```text
{memoryLayer}:{memoryPoint}
```

当前实际语义：

- `session:{row_id}`
  - 指向一条 session memory point（内部落在 turn row 上）
- `observing:{row_id}`
  - 指向一条 observing snapshot row

`observing_id` 不单独暴露为 public `memory_id`；它只用于把多条 observing snapshot rows 归属到同一条 observing line。

### 2.3 Storage Identity Rule

存储层约定：

- 表内主键字段使用 Lance stable `_rowid`
- 不在表内冗余保存格式化后的 `memory_id`
- 对外暴露时再根据 `memory_layer + memory_point` 构造 `memory_id`

## 3. SessionTurn Schema

当前代码层对应的 record 类型是 `SessionTurn`，底层仍然持久化为 `turn` row。其核心字段为：

```ts
type SessionTurn = {
  turn_id: MemoryId;
  created_at: string;
  updated_at: string;
  session_id?: string | null;
  agent: string;
  observer: string;
  title?: string | null;
  summary?: string | null;
  tool_calls_json?: string | null;
  artifacts_json?: string | null;
  prompt?: string | null;
  response?: string | null;
};
```

语义说明：

- `turn_id` 是 session layer 的导航键，值形如 `session:{row_id}`
- `session_id` 是逻辑会话分组键
- `summary` 是可选派生字段，不是写入 `response` 的前提

## 4. Observing Schema

当前 `observing` row 的核心字段为：

```ts
type Observing = {
  snapshotId: MemoryId;
  observingId: string;
  snapshotSequence: number;
  createdAt: string;
  updatedAt: string;
  observer: string;
  title: string;
  summary: string;
  content: string;
  references: string[];
  checkpoint: {
    observingEpoch: number;
    indexedSnapshotSequence?: number | null;
  };
};
```

语义说明：

- `snapshotId`
  - 当前 row 的唯一 identity
  - 对外 `memory_id = observing:{row_id}`
- `observingId`
  - 同一条 observing line 的稳定分组键
- `snapshotSequence`
  - 该 row 在所属 observing line 中的顺序
- `content`
  - 当前 snapshot 的完整内容 JSON
  - 序列化的是 `SnapshotContent`
- `references`
  - 当前 snapshot 的有界来源集合
  - 累计保留形成当前 snapshot 的 provenance
  - 默认最多保留 `1000` 条，超限时优先淘汰最老的 `session:*` 引用
- `checkpoint`
  - 当前 observing line 的 checkpoint 状态
  - 包含 `observingEpoch` 和 `indexedSnapshotSequence`

补充约束：

- `references` 只表示 provenance，不维护 observing-to-observing 的父子关系
- 不保证包含 parent observing ref

当前 `ObservingSnapshot.content` 承载的 payload 形状为：

```ts
type SnapshotContent = {
  memories: ObservedMemory[];
  openQuestions: string[];
  nextSteps: string[];
  memoryDelta: LlmFieldUpdate<ObservedMemory>;
};

type LlmFieldUpdate<T> = {
  before: T[];
  after: T[];
};

type ObservedMemory = {
  id?: string | null;
  text: string;
  category: "Preference" | "Fact" | "Decision" | "Entity" | "Concept" | "Other";
  updatedMemory?: string | null;
};
```

补充说明：

- `memories` 是当前 snapshot 的完整 materialized memory 集合
- `openQuestions` / `nextSteps` 是 full-image 状态字段
- `memoryDelta` 只描述本次 snapshot 相对上一版的 memory 变化
- 不再单独维护 `concepts` 列表；概念类信息通过 `ObservedMemory.category = "Concept"` 表达

当前已经废弃的旧聚合行字段：

- `snapshot`
- 顶层 `indexed_snapshot_sequence`
- `snapshots`
- `change_log`
- `turn_observed`

## 5. Current Write Type

当前正式写接口是完整 turn capture：

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
```

补充说明：

- `observer` 不属于 `TurnContent`，它在 backend/session 路径内部注入并落到 `SessionTurn`
- `title` / `summary` 不属于 `TurnContent`，它们是 `SessionTurn` 上的派生/存储字段
- `toolCalls` 在 row 内部以 `tool_calls_json` 持久化
- `artifacts` 在 row 内部以 `artifacts_json` 持久化

## 6. Current Read Contract

当前统一读侧仍然通过：

```ts
export interface MemoryHit {
  memoryId: string;
  content: string;
}
```

sidecar/MCP 返回的最终载体是 `MemoryHit[]`，但底层结构化读取在 core 内部分层进行：

- `list`
  - layer 的顶层浏览单元列表
- `detail`
  - 单个 memory row
- `timeline`
  - 单个 anchor row 周围的同层邻近 rows

对于 `observing`：

- `list` 返回每条 observing line 的 latest snapshot row
- `detail` 返回单个 snapshot row
- `timeline` 返回同一 `observing_id` 下按 `snapshot_sequence` 排序的邻近 snapshot rows

## 7. Checkpoint Contract

当前 checkpoint schema 为：

```ts
type RecentTurn = {
  turnId: string;
  updatedAt: string;
  prompt: string;
  response: string;
};

type RecentSessionCheckpoint = {
  sessionId?: string | null;
  agent: string;
  turns: RecentTurn[];
};

type CheckpointContent = {
  schemaVersion: 3;
  observer: {
    baseline: {
      turn: number;
      observing: number;
      semanticIndex: number;
    };
    committedEpoch?: number;
    nextEpoch: number;
    recentSessions: RecentSessionCheckpoint[];
    threads: ThreadRef[];
  };
};
```

语义说明：

- `RecentTurn` 只用于 recent dedupe window
- `RecentTurn` 不是完整 `SessionTurn` 缓存
- 当前 dedupe 仍然只比较 `prompt + response`
- checkpoint 文件路径当前按 `storage + observer.name` 分桶

恢复语义：

- 先恢复 checkpoint 内的 `recentSessions`
- 再按 `baseline.turn` replay turn delta
- 用 delta 中新增的 persisted turns 补齐 checkpoint 之后的 recent dedupe 窗口
- 同一 session 的 dedupe window 仍然只保留最近若干条 `RecentTurn`

## 8. Thinking

`thinking` 仍属于保留中的 memory layer。

当前已确定：

- `thinking` 属于独立 memory layer
- 对外导航键格式为 `thinking:{row_id}`

当前未确定：

- 正式写入 schema
- 聚合与更新策略
