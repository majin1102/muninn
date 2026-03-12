# Munnai 模块语言与技术栈选型调研

## 1. 约束与目标（来自现有文档）

Munnai 的核心不是“某个特定实现”，而是围绕统一 `memory_id` 的 **text-first MCP（Markdown 渲染）** 与 **渐进式披露** 工作流，构建一个可互操作的记忆服务。

从文档中可以归纳出对实现选型影响最大的硬约束：

- **薄 MCP Server**：只做 stdio MCP 协议与 tool schema、参数校验/标准化、错误包装，转发到 sidecar；不承载业务逻辑、不存状态（[munnai-mcp-design.md](file:///Users/Nathan/workspace/munnai/docs/munnai-mcp-design.md)）。
- **强 Sidecar**：sidecar 实现 recall/list/get_timeline/get_detail 的语义、排序规则、Markdown 渲染、列裁剪/预算控制、可选向量召回（[munnai-mcp-api.md](file:///Users/Nathan/workspace/munnai/spec/munnai-mcp-api.md)，[munnai-format-schema.md](file:///Users/Nathan/workspace/munnai/spec/munnai-format-schema.md)）。
- **统一导航键**：MCP 只暴露 `memory_id`（`thinking_`/`session_`/`message_` 前缀 + ULID 建议），维度解释由服务端根据前缀路由完成（[munnai-mcp-api.md](file:///Users/Nathan/workspace/munnai/spec/munnai-mcp-api.md)）。
- **存储实现不绑定**：schema/spec 允许 Iceberg/Lance/SQLite/其他，只要求语义与输出一致；但设计文档倾向 Arrow/Lance 的列裁剪与向量检索能力（[munnai-format-schema.md](file:///Users/Nathan/workspace/munnai/spec/munnai-format-schema.md)）。

## 2. 模块拆分（工程边界）

按职责/演进风险拆成可独立选型的模块：

1. MCP Server（thin wrapper，stdio）
2. Sidecar HTTP Service（核心业务逻辑与渲染）
3. Storage Adapter（message/session/thinking 三表的读写抽象）
4. Index & Retrieval（全文/向量/混排策略，可选但会影响语言选型）
5. Renderer（Markdown 输出一致性与裁剪策略）
6. Writer/采集入口（未来扩展：写入策略、脱敏、截断）
7. Observability & Deploy（日志/指标/健康检查/打包分发）

## 3. 关键依赖生态现状（影响选型的“硬件”）

### 3.1 MCP SDK 的语言覆盖

官方 reference servers 仓库明确列出多语言 MCP SDK（C#/Go/Java/Kotlin/PHP/Python/Ruby/Rust/Swift/TypeScript 等），并以“参考实现/教育用途”为定位（https://github.com/modelcontextprotocol/servers）。

这意味着：**MCP Server 选语言主要看开发效率与运行时依赖，不会被协议本身强绑**。

另外，MCP 官方站点对 MCP 的定位是开放标准、连接 AI 应用与外部系统的“通用接口”（https://modelcontextprotocol.io/）。

### 3.2 Lance 的实现形态（Rust Core + 多语言绑定）

Lance 项目本身是一个面向 AI/ML 的 lakehouse format，仓库 README 明确：

- 有 **Core Rust implementation**，并提供 Python/Java bindings（目录结构：`rust/`、`python/`、`java/`）（https://github.com/lancedb/lance）。
- 提供 **hybrid search** 能力：将向量相似检索、全文 BM25、以及 SQL analytics 放在同一数据集上，并可通过二级索引加速（https://github.com/lancedb/lance）。

这对 Munnai 很关键：如果把 storage 锚定在 Lance，一套存储就能覆盖 “列裁剪 + 全文/向量检索 + 版本能力” 的大部分需求，sidecar 的实现复杂度会下降。

## 4. 模块级选型：候选与推荐

下表给出各模块最现实的候选与推荐（按“最符合当前文档架构 + 可落地 + 后续演进成本”排序）。

| 模块 | 推荐（主推） | 备选 | 为什么 |
|---|---|---|---|
| MCP Server（stdio） | TypeScript/Node | Rust | TS/Node 有成熟生态与快速迭代；Rust 可做单二进制、减少运行时依赖（但生态与开发效率需要团队匹配）。|
| Sidecar（HTTP） | Rust | Python | sidecar 是性能与可靠性关键路径；Rust 适合高并发、低内存、单二进制；Python 更快出 MVP，但分发与长尾性能/并发需要补强。|
| Storage Adapter | Lance（优先）+ SQLite 兜底 | SQLite 先行 | Lance 能同时支撑随机访问、列裁剪、向量/全文；SQLite 适合最小可用与简化依赖，但向量与列裁剪能力有限。|
| Index & Retrieval | Lance 内置（向量 + BM25） | 外置检索引擎（Tantivy/Meilisearch 等） | 优先“少系统”达成 recall/list/timeline；外置引擎适用于极端规模或更复杂混排。|
| Renderer（Markdown） | sidecar 内纯函数模块（强测试） | 共享渲染库（多语言） | 输出一致性是 text-first 的生命线，优先用黄金样例（golden files）保证一致。|
| Writer/采集入口 | HTTP API + 可选 CLI | 仅 CLI | 后续写入策略（脱敏、截断、记录 prompt/response）与审计会逐步变复杂，API + CLI 更灵活。|
| Deploy | sidecar 单二进制 + MCP wrapper（Node 或同二进制） | 全 Rust 单二进制 | “Node wrapper + Rust sidecar” 是工程上最常见的折中；全 Rust 可做极简分发，但要求 Rust MCP SDK/实现稳定。|

## 5. 推荐技术路线（主推 1 套 + 备选 1 套）

### 路线 A（主推）：TS MCP Wrapper + Rust Sidecar + Lance 存储

**适用前提**
- 目标用户群里允许安装 Node（或通过打包把 wrapper 也封装起来）。
- 希望 sidecar 以单二进制形式分发（便于本地运行/容器化）。

**好处**
- MCP wrapper 完全“薄”：TS 迭代快，能快速对齐 tools schema 与错误包装策略。
- 核心复杂度集中在 Rust sidecar：性能、并发、列裁剪、索引都可控。
- Lance 有 Rust core，可避免“Python 才是主实现”的尴尬路径（https://github.com/lancedb/lance）。

**需要注意**
- 需要定义清晰的 HTTP 契约：错误码、超时、幂等、request_id 贯穿日志。
- wrapper 与 sidecar 版本要有兼容策略（例如 sidecar `/version` 或 capability 握手）。

### 路线 B（备选）：全 Rust（MCP Server + Sidecar）单二进制

**适用前提**
- 非常看重“零运行时依赖”的本地分发体验（一个文件可跑）。
- 团队对 Rust 工程化（async/http/json/schema validation/testing）有把握。

**好处**
- 本地部署最简单：一个二进制同时承担 MCP stdio 与业务逻辑。
- 消除 wrapper↔sidecar 的跨进程/跨端口复杂度（尽管这与现有文档的“薄 wrapper + HTTP sidecar”略有偏离）。

**风险**
- 与生态对齐：需要确认 Rust MCP SDK 的接口、工具链与社区成熟度能支撑快速迭代（参考多语言 SDK 列表：https://github.com/modelcontextprotocol/servers）。

## 6. 关键技术点建议（实现无关，但会影响选型成败）

### 6.1 输出一致性（text-first 的“正确性”）

- 任何 tool 输出都应视为 API：排序、字段裁剪、Markdown 模板都必须可测试。
- 建议每个 tool 都建立 golden 测试样例：同一输入数据集必须产生 byte-level 稳定输出（尤其是 `get_timeline` 的升序规则与 `list` 的降序规则）。

### 6.2 “列裁剪/预算控制”要前置到数据访问层

文档强调 token/IO 预算与轻字段优先，这意味着：

- storage adapter 的查询 API 需要显式区分 “index hit（轻字段）” 与 “detail（重字段）”。
- `recall/list` 默认只读 `id/time/agent/summary + 少量 details`；`get_detail` 才读长字段（trace/artifacts/notes）。

### 6.3 检索策略：先少系统，后精细化

Munnai 的工具工作流天然分层：

- `recall` 返回候选（可混入 session/thinking/message）
- `get_timeline` 做同维度扩展（窗口）
- `get_detail` 做终点下钻

因此检索策略建议循序渐进：

1. MVP：先用最简单的全文匹配/过滤把工作流跑通
2. v1：引入 BM25/倒排（Lance 若可用则优先用其全文能力）
3. v2：引入向量召回与混排（向量相似 + recency + 维度配比）

### 6.4 安全与隔离（本地 sidecar 的现实威胁模型）

虽然 Munnai 是记忆服务，但它仍是一个本地/远端可访问的 HTTP 服务：

- 默认只绑定 localhost，显式配置才允许 remote bind。
- 任何可读文件/可执行命令能力都应避免进入 sidecar；sidecar 只处理自己的 dataset 路径与配置白名单。

## 7. 建议的落地路线（阶段与验收标准）

### 阶段 1：协议与工作流对齐（端到端可跑）

- MCP tools：`_GUIDE/recall/list/get_timeline/get_detail` 全部可调用
- sidecar HTTP 契约固定：输入参数校验、错误模型、请求超时
- 端到端数据源：先用最简单的本地 JSON/CSV 或 SQLite 都可

验收：同一输入数据集，所有 tool 输出稳定可复现（golden 测试通过）。

### 阶段 2：存储落地（Lance 优先）

- message/session/thinking 三表落地为 Lance dataset（或保留 adapter 可插拔）
- 实现列裁剪：recall/list 与 get_detail 的字段读取明显不同

验收：数据量上来后仍能保持可接受的响应；随机访问与窗口查询正确。

### 阶段 3：检索增强（全文/向量/混排）

- 全文检索：BM25 或同等级能力
- 向量检索：IVF/量化索引等（Lance 提供相关能力：https://github.com/lancedb/lance）
- thinking_ratio 的“预算建议”在服务端真正生效（作为混排约束而非仅透传）

验收：recall 结果相关性与稳定性满足预期；timeline 与 detail 仍严格遵守排序与裁剪规则。
