# OpenClaw 对接工作线 Brief

## 目的

这条工作线的目标，是让 Muninn 真正进入 OpenClaw 的实际工作流，而不是停留在孤立 demo。

它要解决的问题是：

- OpenClaw 在真实运行过程中产生的上下文，如何稳定写入 Muninn

## 产品目标

OpenClaw 应该能够在不打断主流程的前提下，将执行过程中的关键信息自动写入 Muninn。

## 范围

这条工作线包含：

- 梳理上游 `../openclaw` 中可用的 hook
- 判断哪些 hook 应该写入 Muninn
- 将 OpenClaw hook 映射到 Muninn 的写入入口
- 确保写入失败不会阻塞 OpenClaw 主流程
- 明确重复 hook、重试、重启等情况在 MVP 中的处理边界与后续补齐点

这条工作线不包含：

- 长期 memory schema 设计
- observation 生成逻辑本身
- Muninn Board 界面实现
- Muninn MCP recall 能力设计

## 当前方向

当前 MVP 方向已经明确：

- 写入路径应该面向 `session`
- 当前建议写入口是 `POST /api/v1/session/messages`
- `session_id` 只是逻辑归属参考，不是严格生命周期边界
- OpenClaw MVP 优先使用 `before_model_resolve` 采集本轮 user prompt，而不是继续依赖 legacy `before_agent_start`
- MVP 1 不引入 `session/start` 和 `session/end`

## 这条线必须回答的问题

- OpenClaw 里哪些 hook 稳定且适合做记忆写入？
- MVP 1 的写入粒度到底应该多细？
- 哪些执行信号值得写入，哪些只是噪音？
- 重试、重复写入、agent 重启在 MVP 中先保证什么，不保证什么？
- Muninn 不可用或延迟较高时，OpenClaw 应该如何退化？

## 预期产出

- 一份 OpenClaw hook 到 Muninn 写入的映射说明
- 一套最小可用的 OpenClaw 接入实现
- 一版清晰的写入语义说明
- 一条可以在真实 OpenClaw 执行中跑通的写入链路

## 约束

- OpenClaw 是第一接入方，但设计不应被永久绑定为 OpenClaw 私有能力
- 写入 Muninn 不能成为 OpenClaw 的强阻塞依赖
- MVP 的失败处理先收敛为“写失败只打日志，不阻塞主流程”
- MVP 1 不要过度设计生命周期语义
- 接入方式要和后续 memory 蒸馏工作兼容

## 如何判断有进展

这条工作线的有效进展应该表现为：

- 对 OpenClaw hook 的理解更清楚
- hook 到写入入口的映射更稳定
- 写入语义更明确
- OpenClaw 真实执行输出能够进入 Muninn

## MVP 1 完成标准

当下面这些条件都满足时，这条工作线可以认为对 MVP 1 足够完成：

- OpenClaw 能在真实使用中自动把执行上下文写入 Muninn
- 这条接入链路已经稳定到足以反复本地验证
- Muninn 写入失败或延迟过高时，OpenClaw 主流程仍能继续执行，且退化行为已明确
- 写入结果足以支撑下游的 session 和 observation 蒸馏

## 如何使用这份 Brief

给 agent 分配这条工作线时：

- 一次只推进一个具体接入步骤
- 优先安排 hook 梳理、映射、实现或验证任务
- 要求 agent 在结束时留下结论和下一步建议
