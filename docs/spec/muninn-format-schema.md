# Muninn Format Schema Spec

本文档描述 Muninn 当前代码中的核心 format 对象、标识语义和持久化约定。

## 1. Current Persisted Units

当前已经落地的持久化 rows 是：

- `turn`
  - 一行表示一个完成或进行中的 turn row
  - `session_id` 是可选逻辑分组键，不是 row 主键
- `session_snapshot`
  - 一行表示 extractor 生成的一版 session memory snapshot
  - `session_id + agent + project + cwd + extractor` 共同限定 snapshot 归属
- `extraction`
  - 一行表示可召回的 extraction memory
  - 通过稳定 `id` upsert，带向量索引和 full-text 索引

当前只保留 `turn`、`session_snapshot`、`extraction` 三类持久化 memory 表。

## 2. Memory Layers And Identity

对外 contract 使用：

```text
memoryId = {memoryLayer}:{memoryPoint}
```

当前有效 memory id：

- `session:{row_id}`
  - 指向一条 turn row，用作 conversation/session timeline 的导航点
- `extraction:{id}`
  - 指向一条 extraction row，用作 recall/detail 的长期记忆单元

存储层约定：

- Lance row 主键依赖表内 stable `_rowid` 或 extraction 的稳定 `id`
- 不在 turn/session snapshot 表内冗余保存格式化后的 `memory_id`
- 对外暴露时由 API 层构造 `memoryId`

## 3. Turn Schema

当前代码层对应的 record 类型是 `SessionTurn`，底层持久化为 `turn` row。核心字段为：

```ts
type SessionTurn = {
  turn_id: string;
  created_at: string;
  updated_at: string;
  session_id?: string | null;
  turn_sequence?: number | null;
  project: string;
  cwd: string;
  agent: string;
  extractor: string;
  events_json: string;
  artifacts_json?: string | null;
  metadata_json?: string | null;
  prompt?: string | null;
  response?: string | null;
  extraction_epoch?: number | null;
};
```

语义说明：

- `turn_id` 对外渲染为 `session:{row_id}`
- `extractor` 是写入该 turn 的 extractor runtime 名称
- `extraction_epoch` 用于 extractor epoch 进度
- `events_json` / `artifacts_json` / `metadata_json` 保存原始结构化输入

## 4. Session Snapshot Schema

`session_snapshot` row 的核心字段为：

```ts
type SessionSnapshot = {
  session_id: string;
  project: string;
  cwd: string;
  agent: string;
  snapshot_sequence: number;
  created_at: string;
  updated_at: string;
  extractor: string;
  title: string;
  summary: string;
  content: string;
  references: string[];
};
```

语义说明：

- `content` 是 session memory snapshot 的完整 Markdown/JSON payload
- `references` 保存 snapshot 的来源 turn/session/extraction refs
- session snapshot 支撑 Web session tree、session detail 和 extractor checkpoint 恢复

## 5. Extraction Schema

`extraction` row 的核心字段为：

```ts
type Extraction = {
  id: string;
  title: string;
  summary: string;
  content: string;
  cwd: string;
  vector: number[];
  turnRefs: string[];
  createdAt: string;
  updatedAt: string;
};
```

语义说明：

- `id` 是 extraction 的稳定 upsert key，对外 `memoryId = extraction:{id}`
- `vector` 使用当前 extractor embedding provider 的维度
- `turnRefs` 是 provenance refs
- recall 只查询 extraction rows，再按 `turnRefs` 回溯上下文

## 6. Current Write Type

当前正式写接口是完整 turn capture：

```ts
export interface TurnContent {
  sessionId: string;
  project?: string;
  cwd?: string;
  agent: string;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
  turnSequence?: number;
  events: TurnEvent[];
  artifacts?: Artifact[];
  prompt?: string;
  response?: string;
}
```

补充说明：

- `extractor` 不属于 `TurnContent`，它在 backend/session 路径内部注入并落到 `SessionTurn`
- `title` / `summary` 不属于 `TurnContent`，它们是派生字段
- extractor 使用 `prompt` / `response` / `summary` 这些文本投影，不直接消费 raw tool output

## 7. Current Read Contract

HTTP/MCP 读侧统一返回：

```ts
export interface MemoryHit {
  memoryId: string;
  content: string;
}
```

当前结构化读取：

- `list`
  - 返回最近 session memory points
- `detail`
  - 支持 `session:{row_id}` 和 `extraction:{id}`
- `timeline`
  - 支持以 `session:{row_id}` 为锚点的 turn timeline
- `recall`
  - 查询 extraction table，返回 extraction memory hits

## 8. Checkpoint Contract

当前 checkpoint schema 为：

```ts
type CheckpointContent = {
  schemaVersion: 11;
  extractor: {
    baseline: {
      turn: number;
      session: number;
      extraction: number;
    };
    committedEpoch?: number;
    nextEpoch: number;
    recentSessions: RecentSessionCheckpoint[];
    threads: ThreadRef[];
    runs: ExtractorRun[];
  };
  sessionIndex: {
    baseline: {
      turn: number;
      session: number;
    };
    entries: SessionIndexEntry[];
  };
};
```

语义说明：

- checkpoint 只恢复 extractor 和 session index 状态
- 不再包含额外 worker section、第二阶段 watermark phase 或 queued extraction handoff
- 旧 checkpoint schema 不做兼容读取

## 9. Reserved Layers

`thinking` 仍是保留中的 memory layer，当前没有正式写入 schema。
