# 记忆蒸馏工作线 Brief

## 目的

这条工作线承担的是 Muninn 的核心产品价值：

- 把原始执行上下文变成更高价值的记忆

如果没有这条线，Muninn 只会像日志系统，而不像记忆系统。

## 产品目标

Muninn 应该能够从 session 输入中形成 observation 记忆，并进一步产出可以被 OpenClaw 直接召回的精炼记忆结果。

## 范围

这条工作线包含：

- 明确 `session` 的产品角色
- 明确 `observation` 的产品角色
- 明确记忆蒸馏的基本策略
- 明确 session 和 observation 如何共同进入对齐 OpenClaw 的 semantic memory 产物
- 明确如何与 OpenClaw 自带 LanceDB plugin 做 benchmark 对比

这条工作线不包含：

- OpenClaw hook 接入实现本身
- 长期 thinking 层设计
- Muninn MCP recall 接口设计
- Muninn Board 界面实现

## 当前方向

当前 MVP 方向已经明确：

- `session` 用来保留接近真实过程的工作记忆
- `observation` 用来保留更可复用的观察和总结
- 面向 OpenClaw 的 semantic memory 结果不是原始数据同步
- 它是经过整理、蒸馏、精炼后的记忆投影
- MVP 1 的 recall 验证路径，是 OpenClaw 自己直接召回这些记忆，而不是 Muninn MCP recall
- `turn` 级别的蒸馏不应默认依赖 LLM 改写
- 如果原始 `prompt` / `response` 已经在预算内且结构清晰，优先保真直出 `summary`
- `title` 可以独立生成；不要为了生成 `title` 强制重写 `summary`
- 只有 turn 过长、过程化明显、或原文不适合作为记忆条目时，才走完整 LLM 蒸馏

## 这条线必须回答的问题

- 什么样的 session 才是有价值的，而不是噪音？
- 什么样的 observation 值得被生成？
- observation 应该在什么时候产生？
- 哪些内容应该进入精炼记忆层，哪些不应该？
- 应该如何和 OpenClaw 自带 LanceDB plugin 做公平 benchmark？
- token 成本应该如何评估？

## 预期产出

- 一版清晰的 session / observation 产品角色说明
- 一版可工作的蒸馏策略
- 一版对齐 OpenClaw 的精炼记忆方案
- 一套 benchmark 任务和评估标准
- 一批可供人工评审的样例产出

## 约束

- 不要把 semantic memory 当成原始输入的镜像
- 不要在 MVP 定义阶段过早展开 schema 细节
- 重点始终放在质量、压缩效果和召回价值上
- 每一步蒸馏都应该能用产品语言解释清楚
- 如果压缩收益明显小于信息损失风险，应优先保真而不是优先改写
- 对短且高信息密度的 turn，不要默认把 LLM 当作格式化器或润色器
- summary 和 title 的生成职责要解耦：summary 追求记忆保真，title 追求检索抽象

## 如何判断有进展

这条工作线的有效进展应该表现为：

- 原始上下文和记忆之间的边界更清晰
- observation 的质量更高
- 精炼记忆对 recall 更有帮助
- benchmark 方案和结果更有说服力
- 能明确区分哪些 turn 应该直接保真入记忆，哪些 turn 需要 LLM 蒸馏
- 对 `title` / `summary` 的链路选择更可解释，而不是所有输入都走同一路径

## MVP 1 完成标准

当下面这些条件都满足时，这条工作线可以认为对 MVP 1 足够完成：

- Muninn 能基于真实 OpenClaw 输入产出 session 和记忆 observation
- Muninn 能产出可被 OpenClaw 直接召回的精炼记忆
- benchmark 结果显示，召回准确性优于 OpenClaw 自带 LanceDB plugin
- 在相近或更好效果下，token 消耗表现更优或至少足够有竞争力

## 如何使用这份 Brief

给 agent 分配这条工作线时：

- 一次只推进一个蒸馏、召回或评测问题
- 优先让 agent 产出样例、实验结论和 benchmark 思路
- 要求 agent 明确写出 tradeoff 和下一步最值得做的实验
