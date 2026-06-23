# Prompt-Only Probe: Memory Signal Boundary Regression

This fixture is detached from Muninn runtime code. It is a prompt-only probe:
paste the model task into an LLM and inspect the JSON result. Do not use Muninn
tables, extractor parsing, project dreaming, or imported sessions.

## What This Probe Tests

Use the same input with these rule sets:

1. `old-strict-rules`: no explicit durable repo/module boundary allowance.
2. `current-boundary-rules`: includes durable repo/module boundaries that
   constrain future project changes.
3. `direct-correction-rules`: removes broad durable repo/module boundary
   allowance and only admits direct user corrections that tell future agents
   what to avoid or prefer beyond the current task.

Observed on 2026-06-21:

- `old-strict-rules` did **not** reproduce the Amoro miss; the LLM still
  captured the common code path boundary.
- `current-boundary-rules` captured the Amoro boundary, but also reproduced the
  Muninn noise by admitting schema/pipeline design facts as Memory Signals.

So the minimal prompt-only reproduction is currently:

- Not: "Amoro boundary is dropped."
- Yes: "`durable repo/module boundaries that constrain future project changes`
  is broad enough to pull Muninn schema/pipeline facts back into Memory Signals."
- Fix direction: use direct user corrections as the narrow entry point instead
  of broad repo/module boundary language.

## Model Task

You are testing Memory Signal extraction from user prompts only.

Use one of these rule sets.

### old-strict-rules

- Memory Signals are AGENTS.md/MEMORY.md-style operating instructions for future
  agents working on the project: standing user preferences, agent-behavior
  corrections, edit/review style, recurring environment quirks, and explicit
  remember requests.
- Do not record task-bound facts as Memory Signals unless the user explicitly
  asks to remember or reuse them as future-agent instructions.
- Task-bound facts include design or implementation decisions about the artifact
  being built, edited, or reviewed; requirements for the current
  prompt/spec/doc/test/UI/API/schema or storage change;
  PR/CI/review/debug/import/finalize progress; and investigation findings or
  tradeoffs that explain the current solution but do not tell future agents how
  to act.
- Use only user prompts as Memory Signal evidence.
- Preserve the intended scope. Do not broaden a task instruction into a general
  project convention.
- Write Memory Signals as direct future-agent instructions in the dominant
  language of the user prompts.

### current-boundary-rules

- Memory Signals are AGENTS.md/MEMORY.md-style operating instructions for future
  agents working on the project: standing user preferences, agent-behavior
  corrections, edit/review style, recurring environment quirks, explicit
  remember requests, and durable repo/module boundaries that constrain future
  project changes.
- Do not record task-bound facts as Memory Signals unless the user explicitly
  asks to remember or reuse them as future-agent instructions.
- Memory Signals may capture durable repo/module boundaries, but not the
  task-specific decisions, rationale, or implementation state that produced
  them.
- Task-bound facts include design or implementation decisions about the artifact
  being built, edited, or reviewed that do not define a durable repo/module
  boundary; requirements for the current prompt/spec/doc/test/UI/API/schema or
  storage change; PR/CI/review/debug/import/finalize progress; and investigation
  findings or tradeoffs that explain the current solution but do not tell future
  agents how to act.
- Use only user prompts as Memory Signal evidence.
- Preserve the intended scope. Do not broaden a task instruction into a general
  project convention.
- Write Memory Signals as direct future-agent instructions in the dominant
  language of the user prompts.

### direct-correction-rules

- Memory Signals are AGENTS.md/MEMORY.md-style operating instructions for future
  agents working on the project: standing user preferences, direct corrections
  to agent behavior, edit/review style, recurring environment quirks, and
  explicit remember requests.
- Do not record task-bound facts as Memory Signals unless the user explicitly
  asks to remember or reuse them as future-agent instructions.
- A direct user correction may become a Memory Signal when it tells future
  agents what to avoid or prefer beyond the current task; record only the
  corrected action, with the user's narrow scope and constraints.
- Task-bound facts include design or implementation decisions about the artifact
  being built, edited, or reviewed; requirements for the current
  prompt/spec/doc/test/UI/API/schema or storage change;
  PR/CI/review/debug/import/finalize progress; and investigation findings or
  tradeoffs that explain the current solution but do not tell future agents how
  to act.
- Use only user prompts as Memory Signal evidence.
- Preserve the intended scope. Do not broaden a task instruction into a general
  project convention.
- Write Memory Signals as direct future-agent instructions in the dominant
  language of the user prompts.

Return JSON only:

```json
{
  "amoro": {
    "memorySignals": ["- [N] ..."],
    "rejected": ["..."]
  },
  "muninn": {
    "memorySignals": ["- [N] ..."],
    "rejected": ["..."]
  }
}
```

## Input

### Project: github.com/majin1102/amoro

User prompts:

1. 所以这是个 common code path 的bug? 还是说我们做 lance 适配引入的问题，要改
   common path 来修复？
2. 那你就不应该为了lance 去改 common code path!
3. 参考 Iceberg 的分层原则，解决问题，同时不要改到 common code path
4. PLEASE IMPLEMENT THIS PLAN: 修复 Lance Table Properties Secret 暴露。Summary:
   按 Iceberg 的分层原则修：catalog/namespace 连接配置只用于 Lance SDK，不作为
   table properties 暴露。不修改 amoro-common 或任何 common catalog 行为。修复
   范围限制在 amoro-format-lance。

### Project: github.com/majin1102/muninn

User prompts:

1. 讨论或修改 Muninn memory prompt 时，先给我完整 prompt 或策略，我确认后再改；
   优先做减法，不要堆规则。
2. 以后记住：需要用户本机访问远端开发机服务时，server 默认绑定
   `0.0.0.0`，给开发机 IP URL，不要给 `localhost`。
3. 做 Muninn prompt/extractor 规则时，要高信号、反流水账、预算上限明确，必要时
   保留引用。
4. 这次 Muninn 设计里，`session_snapshot.signals` 要作为独立结构化字段，
   Markdown `## Signals` 只作为 LLM/展示交换格式。
5. 本轮 `dreaming` 表 schema 用 `project`、`parent_id`、
   `session_snapshot_version`、`content`，不要 `updated_at`、`summary`、
   `dreamer`。
6. README 文案里描述 Muninn 是 memory format and framework for
   agent-generated context，不要写成普通 memory layer 或 vector DB wrapper。
7. Muninn turn 表要使用一等字段 `turn_sequence` / `turnSequence` 表示源
   transcript 内 turn 顺序。
8. Muninn import 路径只写 raw turn 数据并尽快返回，extraction 和 observation 由后台
   memory pipeline 异步处理。

## Pass/Fail Reading

Amoro miss reproduction:

- Reproduced only if `amoro.memorySignals` is empty or rejects the common code
  path boundary.
- Not reproduced if `amoro.memorySignals` contains a boundary equivalent to
  "do not modify common code path/catalog behavior for Lance-specific work."

Muninn noise reproduction:

- Reproduced if `muninn.memorySignals` includes schema, data-model,
  product-positioning, or pipeline design facts such as
  `session_snapshot.signals`, `dreaming` schema, README positioning,
  `turnSequence`, or import pipeline architecture.
- Not reproduced if `muninn.memorySignals` contains only the three reusable
  prompt/server-access/prompt-quality instructions.

## Observed Direct-Correction Probe

Using the real extractor prompt with `direct-correction-rules` on 2026-06-21:

Amoro Memory Signals:

```md
- [3] 处理 Lance 专属问题时不要为了 Lance 修改 common code path；参考 Iceberg 的分层原则，把修复限制在 Lance 适配层。
```

Muninn Memory Signals:

```md
- [10] 需要用户本机访问远端开发机服务时，server 默认绑定 `0.0.0.0`，并提供开发机 IP URL，不要给 `localhost`。
- [1] 讨论或修改 Muninn memory prompt 时，先提供完整 prompt 或策略，等待确认后再改；优先做减法，不要堆规则。
- [1] 设计 Muninn prompt/extractor 规则时，保持高信号、反流水账、预算上限明确，必要时保留引用。
```

This matches the expected behavior: Amoro keeps the direct correction, while
Muninn schema/data-model/product-positioning/pipeline design facts stay out of
Memory Signals.
