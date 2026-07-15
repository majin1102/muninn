# Agent 记忆赛道格局：融资项目分析

> 2026-06 调研。覆盖已融资的独立记忆公司（mem0 / Letta / Zep / Supermemory），并澄清 claude-mem 与 LangMem 的归属。配合 [../product/strategy-outlook.md](../product/strategy-outlook.md) 阅读。

## 总览

| 项目 | 融资 | 定位一句话 | 主打场景 |
|---|---|---|---|
| Mem0 | $24M（种子 + Series A，2025-10） | 通用记忆 API，"Memory layer for AI" | AI 应用的用户级个性化记忆 |
| Letta (MemGPT) | $10M 种子（2024-09） | 有状态 agent 运行时 → memory-first coding agent | agents that learn |
| Zep (Graphiti) | ~$500K 种子（YC W24） | 时序知识图谱记忆 | 企业场景的事实演化追踪 |
| Supermemory | $2.6M 种子（2025-10） | 通用记忆 API（mem0 挑战者） | 开发者快速接入 |
| claude-mem | 无（开源项目） | Claude Code 记忆插件 | hook 捕获 + 蒸馏 + timeline 召回 |
| LangMem | 无（LangChain 旗下） | 框架自带记忆 SDK | LangGraph 生态内记忆 |

## Mem0 —— 赛道里声量最大的"通用记忆 API"

**融资**：总计 $24M（$3.9M 种子 + $20M Series A，2025-10 公布）。A 轮 Basis Set Ventures 领投，Peak XV、GitHub Fund、YC 跟投，另有 Datadog / Supabase / PostHog 等基础设施公司 CEO 个人投资。

**主打场景**：面向 AI 应用开发者的托管记忆 API——应用把对话发给它，它负责抽取、去重、更新、召回用户级记忆。典型场景是 to-C 应用的个性化（客服、陪伴、助手记住用户偏好与历史）。

**优势**：

- 分发与生态绑定是最强资产：41K GitHub stars、1400 万下载，CrewAI / Flowise / Langflow 原生集成；**AWS 将其选为 Agent SDK 独家记忆供应商**。API 调用量从 2025 Q1 的 3500 万涨到 Q3 的 1.86 亿。
- 研究侧立 flag：论文进 ECAI 2025（十种记忆方案横评）；2026-04 发布单遍分层抽取 + 多信号召回的省 token 算法。

**主要叙事**："Memory layer for AI"——对标 AI 时代的 Stripe/Auth0：每个 AI 应用都需要记忆，但没人该自己造，接 API 即可。赌记忆成为标准化云基础设施组件。

**短板**：托管 API 意味着数据过它的云，对开发者工具/本地 agent 场景不友好；记忆粒度偏"用户事实型"（preferences/facts），对工程类深度上下文（代码决策、踩坑记录）的蒸馏不是强项。

## Letta（MemGPT）—— 学术血统最硬的"有状态 agent"派

**融资**：2024-09 出 stealth 时 $10M 种子，Felicis 领投，Founders Fund、YC 跟投。团队为 UC Berkeley BAIR 的 MemGPT 原班人马。

**主打场景**：原为"stateful agents 平台"——给的不只是记忆 API，而是内置 OS 式虚拟上下文分层的 agent 运行时。**2026 年明显转向**：4 月推出 Letta Code——模型无关、本地运行、git-backed 记忆的编码 agent（号称 Terminal-Bench 第一的开源模型无关 agent），同时砍掉一批服务端功能（templates、legacy memory tools、硬编码多 agent），转向 skills + subagents。

**优势**：

- 概念定义权：MemGPT 论文定义了"虚拟上下文管理"范式，是该领域被引最多的工作；学术叙事能力一流（近期发布 "Context Constitution" 上下文管理原则）。
- 转向后的 Letta Code 路线（本地、git-backed memory、memory-first coding agent）**与 Muninn 的路线最接近，须密切跟踪**。

**主要叙事**：从 "stateful agents" 演进到 "agents that learn"——记忆不是外挂数据库，而是 agent 架构本身的一部分；agent 应从经验中持续学习与自我改进。

**短板**：定位摇摆（研究项目 → agent 平台 → coding agent），商业化路径未收敛；做完整运行时意味着与所有 agent 框架竞争，而非服务它们。

## Zep（Graphiti）—— 时序知识图谱的技术差异化派

**融资**：最小的一家——YC W24，公开仅约 $500K 种子（YC + Engineering Capital 等），尚无 Series A。靠技术声量而非资本支撑。

**主打场景**：企业级 agent 的上下文基础设施。核心是开源的 Graphiti——时序知识图谱引擎，把对话、业务数据、文档实时合成为带时间线的实体关系图。主打"事实随时间变化"的企业场景：CRM、客服、合规——客户上月说 A 本月说 B，系统须知道哪个是现在的真相。

**优势**：

- **双时序模型（bi-temporal）是真正的技术差异点**：每条关系带显式有效期区间；新事实进来时检测冲突，用时间元数据"失效但不丢弃"旧事实。直接解决向量记忆最大的痛点——过时信息污染召回。Muninn 计划中的"矛盾检测、过期"，Zep 做得最认真，值得直接借鉴。
- 论文（arXiv 2501.13956）声称 DMR benchmark 超过 MemGPT；Graphiti MCP Server v1.0（2025-11）接入 Claude Desktop / Cursor，周活 MCP 用户达数十万。

**主要叙事**："Temporal knowledge graph for agent memory"——记忆不是文档堆，而是随时间演化的事实网络；企业场景里"什么时候是真的"与"是什么"同样重要。

**短板**：商业化明显落后于技术声量（2024 年 ~$1M ARR 量级）；2025-04 起砍掉 Zep Community Edition、仅留 Graphiti 开源，开源策略收缩引发社区不满；图谱方案写入成本（每条消息 LLM 抽实体关系）比向量方案高。

## Supermemory —— 新入场的"通用记忆 API"挑战者

**融资**：$2.6M 种子（2025-10），Susa Ventures 领投；个人投资人阵容华丽——Jeff Dean（Google AI）、Logan Kilpatrick（DeepMind）、Cloudflare CTO 及 OpenAI/Meta 高管。创始人为 20 岁的前 Cloudflare DevRel 负责人 Dhravya Shah。

**主打场景**：与 mem0 同位——通用记忆 API，基于知识图谱做个性化上下文，主打接入快、便宜。

**叙事**："universal memory layer"，差异化靠性能/价格与创始人个人品牌。意义在于验证资本仍在持续进入该赛道；与 mem0 正面对撞，胜负取决于分发。

## 澄清：claude-mem 与 LangMem

- **claude-mem**：开源的 Claude Code 记忆插件（hook 捕获 + 压缩 + timeline 召回），无公司无融资。意义在于验证了"hook 自动捕获 + 蒸馏"这条产品路径有真实用户需求——正是 Muninn 的路。详见 [muninn-vs-claude-mem.md](muninn-vs-claude-mem.md)。
- **LangMem**：LangChain 旗下记忆 SDK，不独立融资，背后是估值 10 亿+ 的 LangChain。代表"agent 框架自带记忆"路线——是 Muninn 面临的"被框架层吸收"风险的具体例子。

## 对 Muninn 的参照意义

1. **资本验证充分，但钱集中在"API 化"叙事上。** mem0 的 $24M 与 AWS 独家合作说明"记忆即云服务"是 VC 最买账的故事。Muninn 的本地 sidecar + 格式层路线在该叙事里是逆行的——但这恰是 mem0 们覆盖不了的场景（开发者本地 agent、数据主权）。
2. **Letta 的转向最值得注意。** 拿了 Founders Fund 钱的明星团队，2026 年的答案是"本地、模型无关、git-backed memory 的 coding agent"——与 Muninn 的判断高度收敛。既是路线被验证的信号，也是最直接的潜在竞争。
3. **Zep 证明"防记忆污染"可以做成技术叙事**（bi-temporal、冲突失效），但也证明光有技术叙事不融资不行。其时序失效设计值得 Muninn 在 observation 过期/矛盾检测上直接借鉴。
4. **没有一家在认真做"跨 agent 记忆资产"。** mem0/Supermemory 服务应用开发者（B2D），Letta 在做自己的 agent，Zep 在做企业图谱。"用户在 Claude Code / Codex / OpenClaw 之间携带同一份蒸馏记忆"这个位置目前是空的——这是 Muninn 该死守的差异点。

## 参考来源

- Mem0：[TechCrunch 融资报道](https://techcrunch.com/2025/10/28/mem0-raises-24m-from-yc-peak-xv-and-basis-set-to-build-the-memory-layer-for-ai-apps/)、[Series A 官宣](https://mem0.ai/series-a)、[PR Newswire](https://www.prnewswire.com/news-releases/mem0-raises-24m-series-a-to-build-memory-layer-for-ai-agents-302597157.html)
- Letta：[$10M seed（BigDATAwire）](https://www.hpcwire.com/bigdatawire/this-just-in/letta-emerges-from-stealth-with-10m-to-build-ai-agents-with-advanced-memory/)、[Letta's next phase](https://www.letta.com/blog/our-next-phase)、[Letta Code](https://www.letta.com/blog/letta-code)
- Zep：[论文 arXiv 2501.13956](https://arxiv.org/abs/2501.13956)、[Graphiti GitHub](https://github.com/getzep/graphiti)、[融资（Tracxn）](https://tracxn.com/d/companies/zep/__poSadJnSfLWHjz05Xi3U5KwnpCMWSU3aDrihLX_8FLs)
- Supermemory：[融资报道](https://techkv.com/supermemory-ai-memory-api-funding/)、[Crunchbase](https://www.crunchbase.com/organization/supermemory)
