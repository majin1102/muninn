# MCP / HTTP Naming Study

本文档整理当前仓库周边几个 memory 项目的接口命名风格，回答一个具体问题：

- Munnai 的 MCP / sidecar 接口是否有必要遵守 REST 风格
- `POST /api/v1/session/messages` 这样的写接口命名是否更适合当前 Munnai

调研对象：

- `../claude-mem`
- `../SimpleMem`
- `../SimpleMem-1`

## 1. 结论

先给结论：

- MCP 接口没有必要遵守 REST 风格
- memory 项目的常见做法是分层混合命名，而不是全盘 REST
- MCP tool 层通常使用动作名或能力名
- HTTP 层常常混合资源命名、查询命名、流程命名、生命周期命名
- 资源风格与 workflow 风格在 memory 项目里都常见，Munnai 需要按自身定位做取舍

如果只看接口设计纯度：

- `POST /api/v1/session/messages` 更接近 REST / resource collection 风格

如果更看重 agent workflow / sidecar capability 风格：

- `POST /api/v1/session/messages` 从资源命名角度更干净

所以命名选择的关键不是 “MCP 要不要 REST”，而是：

- Munnai 的 sidecar 长期是偏 agent capability API，还是偏标准资源 API

## 2. 关键判断标准

### 2.1 MCP 层

MCP 的核心是工具调用，不是资源操作。

MCP tool 更看重：

- 工具名是否清楚
- 输入输出是否稳定
- 是否符合 agent 的调用心智
- 是否有利于 token-efficient workflow

MCP 并不要求：

- 使用 REST 风格路径
- 使用资源集合 / 子资源建模

### 2.2 HTTP 层

HTTP 层是否 REST，是项目自己的设计选择。

常见几种风格：

- 资源风格：`/sessions`、`/observations`
- 查询风格：`/search`、`/timeline`
- 生命周期风格：`/sessions/init`、`/sessions/complete`
- 动作风格：`/add-message`、`/summarize`

实际项目里通常是混合使用，而不是强行统一成一种教科书式风格。

## 3. Claude-Mem

### 3.1 MCP 工具命名

`claude-mem` 的 MCP 工具明显偏动作 / 能力名：

- `search`
- `timeline`
- `get_observations`

参考：

- [README.md](/Users/Nathan/workspace/claude-mem/README.md#L201)

这套命名非常符合 MCP tool 心智：

- 先 `search`
- 再 `timeline`
- 最后 `get_observations`

也就是典型的 progressive disclosure workflow。

### 3.2 HTTP 接口命名

`claude-mem` 的 HTTP 接口不是纯 REST，而是混合风格：

- 资源风格：
  - `/api/observations`
  - `/api/settings`
  - `/api/stats`
- 查询 / 视图风格：
  - `/api/search`
  - `/api/timeline`
  - `/api/context/inject`
- 生命周期 / 流程风格：
  - `/api/sessions/init`
  - `/api/sessions/observations`
  - `/api/sessions/summarize`
  - `/api/sessions/complete`

参考：

- [platform-integration.mdx](/Users/Nathan/workspace/claude-mem/docs/public/platform-integration.mdx#L247)
- [hooks-architecture.md](/Users/Nathan/workspace/claude-mem/docs/hooks-architecture.md#L219)
- [api.ts](/Users/Nathan/workspace/claude-mem/src/ui/viewer/constants/api.ts)

### 3.3 对调研问题的意义

`claude-mem` 说明了一点：

- 即便是成熟的 memory / MCP 项目，也不会为了接口“像 REST”而牺牲 workflow clarity

结论：

- `claude-mem` 不支持 “MCP 项目必须 REST” 这个前提

## 4. SimpleMem-Cross

### 4.1 HTTP 接口命名

`SimpleMem-Cross` 的 HTTP 接口更接近资源 + 生命周期混合风格：

- `POST /sessions/start`
- `POST /sessions/{memory_session_id}/message`
- `POST /sessions/{memory_session_id}/tool-use`
- `POST /search`
- `GET /stats`

参考：

- [api_http.py](/Users/Nathan/workspace/SimpleMem/cross/api_http.py)
- [README.md](/Users/Nathan/workspace/SimpleMem/cross/README.md)

它不是纯 REST，但比 `claude-mem` 更偏向资源关系：

- 有 session 子资源
- 有 path parameter
- 也保留了 `start`、`search` 这类流程 / 查询端点

### 4.2 MCP 工具命名

`SimpleMem-Cross` 的 MCP 工具仍然是动作式：

- `cross_session_start`
- `cross_session_message`
- `cross_session_tool_use`
- `cross_session_stop`
- `cross_session_end`
- `cross_session_search`

参考：

- [api_mcp.py](/Users/Nathan/workspace/SimpleMem/cross/api_mcp.py)

### 4.3 对调研问题的意义

`SimpleMem-Cross` 说明：

- 即便 HTTP 层往资源化方向走，MCP tool 层仍然会保留动作命名
- 这是合理分层，不是风格冲突

## 5. SimpleMem MCP Server

`SimpleMem` 主 MCP server 更进一步说明了这个问题。

它的 MCP tool 基本完全是能力名：

- `memory_add`
- `memory_add_batch`
- `memory_query`
- `memory_retrieve`
- `memory_stats`
- `memory_clear`

参考：

- [MCP_INTERFACE.zh-CN.md](/Users/Nathan/workspace/SimpleMem/docs/MCP_INTERFACE.zh-CN.md)
- [mcp_handler.py](/Users/Nathan/workspace/SimpleMem/MCP/server/mcp_handler.py)

它的 HTTP 传输层甚至主要是：

- `POST /mcp`
- `GET /mcp`
- `DELETE /mcp`

也就是说：

- 这里关注的是 MCP 协议承载，而不是 REST 资源建模

对调研问题的意义：

- MCP 本身根本不是围绕 REST 组织的

## 6. 横向比较

| 项目 | MCP 工具层 | HTTP 层 | 结论 |
|---|---|---|---|
| `claude-mem` | 动作 / 能力名 | 混合风格 | 明显不追求纯 REST |
| `SimpleMem-Cross` | 动作 / 生命周期名 | 资源 + 生命周期混合 | HTTP 可更资源化，MCP 仍动作化 |
| `SimpleMem` | 动作 / 能力名 | MCP 传输端点为主 | MCP 与 REST 基本无关 |

从这几个项目看，业界更常见的是：

- MCP 层用动作名
- sidecar / worker HTTP 层按产品工作流混合命名

## 7. 回到 Munnai

### 7.1 当前 Munnai 的读接口

Munnai 当前读接口是：

- `GET /api/v1/recall`
- `GET /api/v1/list`
- `GET /api/v1/detail`
- `GET /api/v1/timeline`

这套接口更接近：

- tool-style HTTP endpoints
- query / operation-oriented endpoints

它们不是典型 REST 资源名，但非常像 agent capability API。

### 7.2 写接口的几个候选

#### 方案 A

`POST /api/v1/message/add`

评价：

- 语义较弱
- 路径组织一般
- 已经不建议继续使用

#### 方案 B

`POST /api/v1/session/add-message`

评价：

- 明确表达“向某个逻辑 session 添加一条 message”
- 与 workflow / capability 风格一致
- 和当前 `recall/list/detail/timeline` 的操作型风格更协调

#### 方案 C

`POST /api/v1/session/messages`

评价：

- 更像 REST 资源集合创建
- 从命名纯度看更干净
- 语义也足够清楚

#### 方案 D

`POST /api/v1/sessions/{session_id}/messages`

评价：

- 最接近传统资源建模
- 但和 Munnai 当前对 `session_id` 的定义有冲突
- 因为当前 `session_id` 只是逻辑归属参考，不是严格生命周期主键

所以当前阶段不适合直接采用。

## 8. 推荐判断

### 8.1 如果 Munnai sidecar 的定位是 agent capability API

建议：

- 保留操作 / workflow 风格
- `POST /api/v1/session/messages` 是当前更推荐的命名

理由：

- 和 `recall/list/detail/timeline` 同类
- 更接近 `claude-mem`、`SimpleMem-Cross` 的 workflow endpoint 思路
- 不会给人错误暗示：`session_id` 不是强资源主键

### 8.2 如果 Munnai sidecar 的长期定位是标准资源 API

建议：

- 逐步往资源命名迁移
- `POST /api/v1/session/messages` 比 `add-message` 更优

理由：

- 路径本身已表达“create message”
- 不需要把动作塞进 path
- 后续若要扩展更多资源关系，也更顺手

### 8.3 当前阶段的实际建议

综合仓库现状，我的建议是：

- 不要把“是否 REST”上升成 MCP 约束
- 把它看成 sidecar HTTP 命名策略问题

如果当前目标是：

- 快速收敛旧的 `message/add`
- 保持与现有读接口风格一致
- 不过度提前承诺资源建模

那么：

- `POST /api/v1/session/messages` 是当前更推荐落地的选择

如果当前目标是：

- 借这次机会顺手把写接口命名做得更标准

那么：

- `POST /api/v1/session/messages` 更优

## 9. 最终结论

最终判断如下：

1. MCP 接口没有必要遵守 REST 风格。
2. 参考项目普遍采用“工具层动作命名 + HTTP 层混合命名”。
3. `claude-mem`、`SimpleMem`、`SimpleMem-Cross` 都不支持“memory/MCP 项目必须纯 REST”这个前提。
4. 对 Munnai 而言，`session/messages` 是当前更优的落地命名。
5. 这一选择的理由不在 MCP，而在 sidecar 的 HTTP 命名策略：当前更偏向资源集合创建语义

## 10. 参考文件

- [../claude-mem/README.md](/Users/Nathan/workspace/claude-mem/README.md)
- [../claude-mem/docs/public/platform-integration.mdx](/Users/Nathan/workspace/claude-mem/docs/public/platform-integration.mdx)
- [../claude-mem/docs/hooks-architecture.md](/Users/Nathan/workspace/claude-mem/docs/hooks-architecture.md)
- [../claude-mem/src/ui/viewer/constants/api.ts](/Users/Nathan/workspace/claude-mem/src/ui/viewer/constants/api.ts)
- [../SimpleMem/cross/api_http.py](/Users/Nathan/workspace/SimpleMem/cross/api_http.py)
- [../SimpleMem/cross/api_mcp.py](/Users/Nathan/workspace/SimpleMem/cross/api_mcp.py)
- [../SimpleMem/docs/MCP_INTERFACE.zh-CN.md](/Users/Nathan/workspace/SimpleMem/docs/MCP_INTERFACE.zh-CN.md)
- [../SimpleMem/cross/README.md](/Users/Nathan/workspace/SimpleMem/cross/README.md)
