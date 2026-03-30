# Munnai Board 工作线 Brief

## 目的

这条工作线的目标，是让人能够直接检查 Munnai 生成出来的记忆到底有没有价值。

Munnai Board 在 MVP 1 的首要职责不是编辑，而是可视化查看与验证。

## 产品目标

Munnai Board 应该让人能够看懂 session 和记忆 observation，从而判断 Munnai 产出的记忆是否清晰、可读、可用。

## 范围

这条工作线包含：

- 明确 Munnai Board 在 MVP 1 的最小信息架构
- 明确 session 应该如何查看
- 明确 observation 应该如何查看
- 明确 session 和 observation 之间的关系该如何展示
- 实现一版只读界面

这条工作线不包含：

- 笔记编辑功能
- 协作能力
- 通用知识库能力
- memory 蒸馏逻辑本身

## 当前方向

当前 MVP 方向已经明确：

- Munnai Board 是只读的
- 它更像记忆查看器，而不是笔记编辑器
- 它要同时帮助人查看 session 和记忆 observation
- 它的首要任务是帮助验证产品价值，而不是堆功能

当前实现状态：

- 基础前端功能已经基本完成
- 已有 session / observation 双视图
- 已有 session 左栏树状浏览、observation 列表与右侧文档阅读区
- 已接入真实 sidecar UI API
- 已提供 Settings 弹窗，可查看与保存 `munnai.json`
- 当前主要未完成项是 logo / 品牌标识，以及少量视觉和交互打磨

## 这条线必须回答的问题

- MVP 1 最少需要哪些页面和视图？
- session 视图最应该展示什么？
- observation 视图最应该展示什么？
- observation 和其来源 session 之间的关系应该怎么呈现？
- 什么样的展示方式最有助于人工判断记忆质量？

## 预期产出

- 一版清晰的 MVP 1 信息架构
- 一版只读的 session / observation 浏览界面
- 一批可以接入真实数据的页面或实现
- 一套关于“记忆是否看起来有价值”的人工反馈

当前进度判断：

- 上述目标已基本落地
- 这条工作线当前更偏向收尾和打磨，而不是继续补一整批基础页面

## 约束

- 不要把 MVP 1 做成完整笔记产品
- 不要过早优化编辑工作流
- 展示必须紧贴真实记忆产物
- 优先保证清晰度和可检查性，而不是功能数量

## 如何判断有进展

这条工作线的有效进展应该表现为：

- 对页面最小范围的判断更清楚
- session / observation 的展示方式更清晰
- UI 更有助于人工判断记忆质量
- 上游产出的记忆问题能更快被暴露出来

## MVP 1 完成标准

当下面这些条件都满足时，这条工作线可以认为对 MVP 1 足够完成：

- 人可以查看 session 记忆
- 人可以查看 observation 记忆
- 人可以理解 observation 和来源 session 的关系
- Munnai Board 足以支撑人工判断 Munnai 产出的记忆是否有价值

按当前状态，这组完成标准里的核心功能已经基本满足；后续主要是 logo 与交互细节收尾。

## 如何使用这份 Brief

给 agent 分配这条工作线时：

- 一次只推进一个 UI 或产品检查问题
- 优先让 agent 产出页面结构、导航方案和展示决策
- 要求 agent 明确记录哪些问题依赖上游的真实记忆结果
