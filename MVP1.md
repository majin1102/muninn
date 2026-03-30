# Munnai MVP 1

## 目标

Munnai MVP 1 要验证的核心产品价值只有一件事：

- agent 在真实工作过程中产生的上下文，能否被 Munnai 自动沉淀为后续可复用的记忆

这个阶段不是为了验证 Munnai 的完整长期架构，而是为了验证最小产品闭环是否成立。

## 产品定义

Munnai 是 agent 的记忆层。

在 MVP 1 中，Munnai 应该做到：

- 从 OpenClaw 的真实执行过程中接收增量上下文
- 将这些上下文整理为 session 记忆
- 从 session 中进一步蒸馏出 observation 记忆
- 将整理和精炼后的记忆产物沉淀为可被 OpenClaw 直接召回的记忆索引
- 提供一个只读的界面，让人可以查看 Munnai 生成出来的记忆

## MVP 1 要验证的产品能力

MVP 1 需要验证以下能力：

- OpenClaw 的执行过程可以被自动记录，而不是人工录入
- Munnai 不只是保存原始过程，还能对记忆进行整理和精炼
- 精炼后的记忆可以直接进入 OpenClaw 自己的记忆召回链路
- 人可以通过 Munnai Board 查看 session 和记忆 observation 的结果
- Munnai Board 的基础前端能力已经可用于人工检查 session / observation，当前主要剩 logo 与少量视觉收尾

## MVP 1 包含什么

### 1. OpenClaw 对接

MVP 1 必须对接 `../openclaw-cn`。

这个对接的目的不是做一个孤立 demo，而是验证：

- Munnai 能不能真正嵌入 agent 的实际工作流
- agent 的记忆写入能不能自动发生
- 后续召回出来的内容是否真的有价值

在这个阶段，OpenClaw 是 Munnai 的第一接入方。

### 2. 面向增量过程的写入入口

MVP 1 的写入接口方向应当是：

- `POST /api/v1/session/messages`

这个接口的产品语义是：

- OpenClaw 在执行过程中持续向某个逻辑 session 添加 message
- `session_id` 只是逻辑归属参考，不是严格生命周期边界
- `agent` 必填，其它 message 字段可按需要单独提供
- Munnai 自己负责把这些增量整理成可用记忆

MVP 1 不需要引入 `session/start` 或 `session/end` 这样的显式生命周期接口。

### 3. Session 和记忆 Observation

MVP 1 明确包含两类记忆产物：

- `session`
- `observation`

它们的产品角色是：

- `session`：尽量保留接近真实过程的工作记忆
- `observation`：从 session 中提炼出的、更适合长期复用的观察和总结

如果只有原始记录，没有 observation，那么这还不算完整验证了 Munnai 的价值。

### 4. 面向 OpenClaw 的记忆蒸馏结果

MVP 1 需要产出一套与 OpenClaw LanceDB memory schema 对齐的记忆索引。

这里要强调：

- 这不是简单同步原始数据
- 这是经过整理、蒸馏、精炼之后的记忆产物
- 这套产物的目标是让 OpenClaw 可以直接召回

这也是 MVP 1 的主召回路径。

MVP 1 暂时不要求 Munnai 自己通过 MCP 暴露同样的召回能力。

### 5. Munnai Board

MVP 1 需要一个只读的 Web 界面：`Munnai Board`。

它的职责是：

- 查看 session 记忆
- 查看 observation 记忆
- 验证 Munnai 生成出来的记忆是否可读、是否有价值

MVP 1 里的 Munnai Board 不是编辑器，也不是完整笔记产品，它首先是一个记忆查看器。

当前前端进展：

- 基础信息架构已完成
- 已实现 `session / observation` 双视图切换
- 已实现 session 左栏浏览、observation 列表与右侧文档详情区
- 已接入真实 sidecar UI API，可查看 live 的 session 与 observation
- 已提供 Settings 弹窗，可查看和保存 `munnai.json`
- 当前主要未完成项是 logo / 品牌标识，以及少量视觉与交互细节优化

## MVP 1 不包含什么

MVP 1 暂时不包含：

- thinking 作为正式写入产物
- 基于 MCP 的记忆召回能力
- 手工编辑型笔记工作流
- 复杂 policy 系统
- 高级排序与重排系统
- 多用户协作
- 云同步或远程后端
- 完整知识库或笔记产品能力

## 验收标准

如果以下几点都成立，就说明 MVP 1 基本成功：

- OpenClaw 能在真实执行过程中持续把上下文写入 Munnai
- Munnai 能把这些上下文整理成 session 记忆
- Munnai 能从 session 中蒸馏出 observation 记忆
- Munnai 能产出可被 OpenClaw 直接召回的精炼记忆
- 人可以通过 Munnai Board 查看 session 和 observation
- Munnai Board 的基础前端已经足够支撑上述查看与人工校验流程
- 相比 OpenClaw 自带的 LanceDB plugin，Munnai 产出的记忆在 benchmark 中具备更高的召回准确性
- 相比 OpenClaw 自带的 LanceDB plugin，Munnai 在达到相近或更好效果时具备更优的 token 消耗表现

## 产品闭环

MVP 1 的判断标准应该基于下面这个产品闭环：

1. OpenClaw 进行真实对话或任务执行
2. 执行过程中的上下文被持续追加到 Munnai
3. Munnai 对这些内容进行整理、蒸馏和精炼
4. OpenClaw 在后续对话中直接召回这些记忆
5. 人可以在 Munnai Board 中检查这些记忆是否合理

如果这个闭环在真实使用中是有价值的，那么 MVP 1 就成立了。
