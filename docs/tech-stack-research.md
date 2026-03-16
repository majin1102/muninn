# Munnai 模块语言与技术栈选型调研（当前 Demo 对齐版）

## 1. 当前约束

基于当前仓库中的 demo，实现约束已经比早期设计更明确：

- **MCP Server**：TypeScript + `@modelcontextprotocol/sdk`
- **Sidecar**：TypeScript + Hono
- **当前存储**：本地 JSONL
- **当前正式写接口**：`POST /api/v1/message/add`
- **当前正式读接口**：`recall`、`list`、`timeline`、`detail`

## 2. 当前模块边界

1. `packages/mcp-server`
2. `packages/sidecar`
3. `packages/sdk`
4. `packages/types`

当前这四部分已经足以支撑 demo：

- MCP 层负责 stdio tool 调用
- sidecar 负责读写 HTTP API
- sdk 负责消费 sidecar
- types 负责共享接口类型

## 3. 当前技术判断

### 3.1 MCP Server

继续使用 TypeScript/Node 是合理的：

- 当前 demo 已经跑通
- 与现有仓库结构一致
- 调试成本低

### 3.2 Sidecar

当前 Hono + Node 的路线适合 demo 阶段：

- HTTP API 迭代快
- 与共享 TS 类型直接对齐
- 本地 JSONL 存储便于调试

### 3.3 Storage

当前 demo 采用本地 JSONL，是合理的最小实现：

- 追加写简单
- 可直接人工检查
- 与 turn 数据很匹配

后续如果规模变大，再考虑数据库或更强的存储后端。

## 4. 当前不做的事情

为了与当前 demo 对齐，以下内容暂不视为当前技术栈承诺：

- Rust sidecar 迁移
- Lance / Arrow 落地
- thinking 写接口
- session 自动聚合算法
- 向量检索与 embedding 写入

## 5. 当前结论

当前仓库最适合继续沿着以下路线推进：

- TS MCP Server
- TS Sidecar
- 共享 TS 类型
- 本地 JSONL 存储

在这个基础上，先把 turn 写入和读接口做稳，再考虑 session 聚合和更复杂的检索能力。
