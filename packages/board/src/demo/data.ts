import type { PipelineTask, SearchSessionResult, ToolCall } from '@muninn/types';

export type DemoSessionAgentItem = {
  agent: string;
  latestUpdatedAt: string;
};

export type DemoSessionGroupItem = {
  sessionKey: string;
  displaySessionId: string;
  projectKey: string;
  latestUpdatedAt: string;
};

export type DemoSessionTimelineItem = {
  memoryId: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
  summary: string;
  prompt?: string;
  response?: string;
  toolCalls?: ToolCall[];
};

export type DemoSessionSnapshotReferenceItem = {
  memoryId: string;
  timestamp: string;
  summary: string;
};

export type DemoSessionSnapshotListItem = {
  memoryId: string;
  title: string;
  summary: string;
  updatedAt: string;
  references: DemoSessionSnapshotReferenceItem[];
};

export type DemoPipelineTask = PipelineTask;

export type DemoMemoryDocument = {
  memoryId: string;
  kind: 'turn' | 'session';
  title: string;
  markdown: string;
  agent?: string;
  sessionId?: string;
  updatedAt?: string;
};

const LONG_DEMO_PROJECT = 'memory-inbox-with-a-very-long-project-name-for-cross-agent-recall';
const LONG_DEMO_SESSION = 'memory-inbox/daily-recall-and-cross-agent-search-regression-review-session';

export const demoSearchResults: SearchSessionResult[] = [
  {
    sessionKey: 'board-mvp',
    sessionLabel: 'board-mvp',
    projectKey: 'board-mvp',
    projectCwd: '/Users/Nathan/.codex/worktrees/dde8/muninn',
    latestUpdatedAt: '2026-06-02T10:30:00.000Z',
    items: [
      {
        id: 'demo-search-provider-model-1',
        source: 'conversation',
        title: 'Provider selector and model routing',
        content: 'Search provider selection should start as a visual control with Default, OpenAI, and Local choices. The BotMessageSquare icon represents the future model/provider switch without implying hardware routing.',
        createdAt: '2026-06-02T10:30:00.000Z',
        memoryId: 'turn:1020',
      },
      {
        id: 'demo-search-provider-extraction-1',
        source: 'extraction',
        title: 'Provider is not active backend routing yet',
        content: [
          '## Summary',
          '',
          'The provider menu is intentionally product-facing only in this version. Search still uses the Board search API and does not send provider-specific model parameters.',
          '',
          '## Content',
          '',
          'Provider selection is kept in the composer because future recall can route through model-backed, agent-backed, or file-backed search providers. In this version the selector is a visual contract: it shows where provider choice will live, but the backend still runs the same board recall path for every provider.',
          '',
          '- `Default` keeps the product ready for model-backed recall.',
          '- `None` skips the answer pane and shows only search evidence.',
          '- The provider icon should read as model-related without implying hardware routing.',
        ].join('\n'),
        createdAt: '2026-06-02T10:36:00.000Z',
        memoryId: 'extraction:demo-provider-routing',
        references: ['turn:1020', 'turn:1021'],
      },
      {
        id: 'demo-search-board-long-1',
        source: 'conversation',
        title: 'Expandable result preview',
        content: [
          'Muninn Board Search uses a fixed-height preview for each hit item.',
          'Long evidence remains available through expand and collapse controls.',
          'This keeps session-level results scannable while preserving enough raw context for manual judgment.',
          'The first version does not generate answers or summaries at the top of the page.',
        ].join('\n'),
        createdAt: '2026-06-01T07:15:00.000Z',
        memoryId: 'turn:1010',
      },
    ],
  },
  {
    sessionKey: 'memory-inbox/daily-recall',
    sessionLabel: LONG_DEMO_SESSION,
    projectKey: LONG_DEMO_PROJECT,
    projectCwd: '/Users/Nathan/workspace/memory-inbox-with-a-very-long-project-name-for-cross-agent-recall',
    latestUpdatedAt: '2026-06-01T13:32:00.000Z',
    items: [
      {
        id: 'demo-search-memory-long-1',
        source: 'conversation',
        title: 'Long project and session title preview',
        content: 'This demo result keeps a long project and session title visible in search filters so menu width, truncation, and single-line behavior can be checked directly.',
        createdAt: '2026-06-01T13:32:00.000Z',
        memoryId: 'turn:1601',
      },
      {
        id: 'demo-search-multimodal-1',
        source: 'conversation',
        title: 'Multi-modal search intake',
        content: 'The plus menu reserves space for image search, file search, and agent search. In the current version those entries are placeholders, but they make the composer ready for multi-modal recall workflows.',
        createdAt: '2026-06-01T13:40:00.000Z',
        memoryId: 'turn:1602',
      },
      {
        id: 'demo-search-agent-icon-1',
        source: 'extraction',
        title: 'Session menu keeps agent icons',
        content: 'Session filter rows keep Codex, Claude, OpenClaw, and fallback agent icons so duplicate session names can still be visually distinguished.',
        createdAt: '2026-06-01T13:45:00.000Z',
        memoryId: 'extraction:demo-agent-icons',
      },
    ],
  },
  {
    sessionKey: 'auth-refactor',
    sessionLabel: 'auth-refactor',
    projectKey: 'auth-refactor',
    latestUpdatedAt: '2026-06-01T12:01:00.000Z',
    items: [
      {
        id: 'demo-search-auth-conversation-1',
        source: 'conversation',
        title: 'Board Search contract',
        content: 'The team decided the Search page should behave like a search engine and group results by session, with Project and Session controls shaping the request scope.',
        createdAt: '2026-06-01T12:01:00.000Z',
        memoryId: 'turn:1005',
      },
      {
        id: 'demo-search-auth-extraction-1',
        source: 'extraction',
        title: 'Request-level scope',
        content: 'Project and Session filters are request-level search scope, not client-side filtering after a broad result set has already been returned.',
        createdAt: '2026-06-01T12:05:00.000Z',
        memoryId: 'extraction:demo-auth-search-scope',
      },
      {
        id: 'demo-search-topn-1',
        source: 'conversation',
        title: 'Top N and Session Top N behavior',
        content: 'Top N controls the number of returned session groups. Session Top N controls how many hit items are kept inside each session result. Both values are user-entered positive integers.',
        createdAt: '2026-06-01T12:12:00.000Z',
        memoryId: 'turn:1006',
      },
    ],
  },
  {
    sessionKey: 'release-check',
    sessionLabel: 'release-check',
    projectKey: 'release-check',
    latestUpdatedAt: '2026-05-26T12:00:00.000Z',
    items: [
      {
        id: 'demo-search-benchmark-1',
        source: 'conversation',
        title: 'LoCoMo benchmark regression triage',
        content: 'Release check reviewed a benchmark regression where recall improved for conversation evidence but extraction recall still missed a small set of LoCoMo questions.',
        createdAt: '2026-05-26T12:00:00.000Z',
        memoryId: 'turn:1301',
      },
      {
        id: 'demo-search-benchmark-extraction-1',
        source: 'extraction',
        title: 'Benchmark evidence source split',
        content: 'Benchmark search should show whether a hit came from conversation or extraction so release debugging can separate raw chat context from distilled memory facts.',
        createdAt: '2026-05-26T12:08:00.000Z',
        memoryId: 'extraction:demo-benchmark-source-split',
      },
    ],
  },
  {
    sessionKey: 'sdk-cleanup',
    sessionLabel: 'sdk-cleanup',
    projectKey: 'sdk-cleanup',
    latestUpdatedAt: '2026-05-18T12:00:00.000Z',
    items: [
      {
        id: 'demo-search-links-1',
        source: 'conversation',
        title: 'Right pane link handoff',
        content: 'Search result links are included now even though the right pane is not implemented in this version. Later the right pane can open the referenced turn, memory, or session without changing the search result shape.',
        createdAt: '2026-05-18T12:00:00.000Z',
        memoryId: 'turn:1401',
      },
      {
        id: 'demo-search-contract-1',
        source: 'extraction',
        title: 'Stable result contract',
        content: 'The Board client receives one stable result contract: session result, metadata line, and hit items. The UI should not branch on storage-specific shapes.',
        createdAt: '2026-05-18T12:10:00.000Z',
        memoryId: 'extraction:demo-stable-result-contract',
      },
    ],
  },
];

export const demoAgents: DemoSessionAgentItem[] = [
  { agent: 'openclaw', latestUpdatedAt: '2026-06-01T12:01:00.000Z' },
  { agent: 'claude_code', latestUpdatedAt: '2026-05-29T12:00:00.000Z' },
  { agent: 'codex_cli', latestUpdatedAt: '2026-05-25T12:00:00.000Z' },
  { agent: 'memory_agent', latestUpdatedAt: '2026-06-01T13:32:00.000Z' },
];

export const demoPipelineTasks: DemoPipelineTask[] = [
  {
    id: 'pipeline:global:lance-row-id',
    kind: 'global-observing',
    title: 'Global observing',
    target: 'Project: lance Session: row-id-recall',
    status: 'running',
    statusText: 'generating draft from 16 extractions',
    startedAt: '2026-06-04T08:12:12.000Z',
    updatedAt: '2026-06-04T08:38:12.000Z',
    input: { bytes: 43600, tokens: 18400 },
    toolCalls: [
      { name: 'get_observation', count: 2 },
      { name: 'get_extraction', count: 3 },
      { name: 'validate_entity', count: 1 },
    ],
    inputDetails: [
      '16 session-level observations',
      '3 source turns from Lance discussions',
      'Entity key: Lance row id',
    ],
    outputDetails: [
      'Entity-level observation draft',
      'Pending parser validation before commit',
    ],
    trace: [
      'selected input: done',
      'generating draft: running',
      'commit output: pending',
      'trace ref: observer-run-42',
    ],
    errors: [],
  },
  {
    id: 'pipeline:session:codex-import-timeline',
    kind: 'session-observing',
    title: 'Session observing',
    target: 'Project: muninn Session: codex session import timeline',
    status: 'done',
    statusText: 'produced 12 extractions and queued global work',
    startedAt: '2026-06-04T08:24:12.000Z',
    endedAt: '2026-06-04T08:36:12.000Z',
    updatedAt: '2026-06-04T08:36:12.000Z',
    input: { bytes: 238000, tokens: 92400 },
    output: { bytes: 12400, tokens: 4800 },
    toolCalls: [
      { name: 'get_turns', count: 5 },
      { name: 'write_observation', count: 12 },
    ],
    inputDetails: ['100 imported turns', 'agent: codex', 'session: import timeline'],
    outputDetails: ['12 session-level observations', 'global observing work queued'],
    trace: [
      'read turns: done',
      'extracted observations: done',
      'queued global work: done',
    ],
    errors: [],
  },
  {
    id: 'pipeline:wiki:memory-architecture',
    kind: 'wiki-compiling',
    title: 'Wiki compiling',
    target: 'Project: muninn Session: memory architecture',
    status: 'queued',
    statusText: 'waiting for global observations before compiling wiki draft',
    updatedAt: '2026-06-04T08:35:12.000Z',
    input: { bytes: 68200, tokens: 27100 },
    toolCalls: [
      { name: 'get_observation', count: 4 },
      { name: 'get_wiki_context', count: 1 },
    ],
    inputDetails: ['Memory architecture observation tree', 'Related entity summaries'],
    outputDetails: ['Wiki page draft', 'Pending source observation readiness'],
    trace: ['waiting for global observations'],
    errors: [],
  },
  {
    id: 'pipeline:global:prompt-design',
    kind: 'global-observing',
    title: 'Global observing',
    target: 'Project: muninn Session: prompt design',
    status: 'queued',
    statusText: 'waiting for extractions before global rewrite',
    updatedAt: '2026-06-04T08:34:12.000Z',
    input: { bytes: 14800, tokens: 6100 },
    toolCalls: [],
    inputDetails: ['5 session-level observations', 'Entity key: Muninn prompt design', 'Below observer threshold'],
    outputDetails: ['Waiting to produce entity observation draft'],
    trace: ['waiting for more extractions'],
    errors: [],
  },
  {
    id: 'pipeline:global:board-settings',
    kind: 'global-observing',
    title: 'Global observing',
    target: 'Project: board-mvp Session: settings polish',
    status: 'failed',
    statusText: 'parser validation failed after 8 extractions · retry retained',
    startedAt: '2026-06-04T08:29:12.000Z',
    endedAt: '2026-06-04T08:32:12.000Z',
    updatedAt: '2026-06-04T08:32:12.000Z',
    input: { bytes: 19600, tokens: 8200 },
    toolCalls: [
      { name: 'get_observation', count: 2 },
      { name: 'validate_entity', count: 1 },
      { name: 'retry_commit', count: 1 },
    ],
    inputDetails: ['8 session-level observations', 'Entity key: Board settings', 'Retry retained'],
    outputDetails: ['Draft failed parser validation', 'No committed observation'],
    trace: [
      'selected input: done',
      'generated draft: done',
      'parser validation: failed',
    ],
    errors: ['parser validation failed'],
  },
];

export const demoSessionGroups: Record<string, DemoSessionGroupItem[]> = {
  openclaw: [
    { sessionKey: 'auth-refactor', displaySessionId: 'auth-refactor', projectKey: 'auth-refactor', latestUpdatedAt: '2026-06-01T12:01:00.000Z' },
    { sessionKey: 'board-mvp', displaySessionId: 'board-mvp', projectKey: 'board-mvp', latestUpdatedAt: '2026-06-01T07:15:00.000Z' },
  ],
  claude_code: [
    { sessionKey: 'auth-refactor', displaySessionId: 'auth-refactor', projectKey: 'auth-refactor', latestUpdatedAt: '2026-05-29T12:00:00.000Z' },
    { sessionKey: 'release-check', displaySessionId: 'release-check', projectKey: 'release-check', latestUpdatedAt: '2026-05-26T12:00:00.000Z' },
  ],
  codex_cli: [
    { sessionKey: 'auth-refactor', displaySessionId: 'auth-refactor', projectKey: 'auth-refactor', latestUpdatedAt: '2026-05-25T12:00:00.000Z' },
    { sessionKey: 'sdk-cleanup', displaySessionId: 'sdk-cleanup', projectKey: 'sdk-cleanup', latestUpdatedAt: '2026-05-18T12:00:00.000Z' },
  ],
  memory_agent: [
    {
      sessionKey: 'memory-inbox/daily-recall',
      displaySessionId: LONG_DEMO_SESSION,
      projectKey: LONG_DEMO_PROJECT,
      latestUpdatedAt: '2026-06-01T13:32:00.000Z',
    },
    { sessionKey: 'auth-refactor', displaySessionId: 'auth-refactor', projectKey: 'auth-refactor', latestUpdatedAt: '2026-05-18T12:00:00.000Z' },
  ],
};

export const demoSessionTurns: Record<string, DemoSessionTimelineItem[]> = {
  'openclaw::auth-refactor': [
    {
      memoryId: 'turn:1001',
      createdAt: '2026-03-20T10:12:00.000Z',
      updatedAt: '2026-03-20T10:12:00.000Z',
      summary: '完成 sidecar 写入口从历史的 message/add 收敛到 turn/capture，并同步校正文档、类型命名和测试描述，让对外语义明确变成一次提交一条完整 turn',
    },
    {
      memoryId: 'turn:1002',
      createdAt: '2026-03-20T10:27:00.000Z',
      updatedAt: '2026-03-20T10:27:00.000Z',
      summary: '确认 extra 只保留在接口传输层，由 sidecar 适配逻辑按需消费，不进入 Rust format、Lance schema、recall 和 detail 渲染，避免污染稳定持久化协议',
    },
    {
      memoryId: 'turn:1003',
      createdAt: '2026-03-20T10:41:00.000Z',
      updatedAt: '2026-03-20T10:41:00.000Z',
      summary: '补 sidecar 写接口和读链路回归测试，覆盖 prompt-only、response-only、tool-only、extra 校验以及写后通过 detail、timeline、recall 回读的主流程行为',
    },
    {
      memoryId: 'turn:1004',
      createdAt: '2026-03-20T11:05:00.000Z',
      updatedAt: '2026-03-20T11:05:00.000Z',
      summary: '开始搭建 Muninn Board 的页面承载位与最小信息架构，先把顶栏、左右分栏、详情文档区和模式切换稳定下来，再逐步接入真实 sidecar UI API',
    },
    {
      memoryId: 'turn:1005',
      createdAt: '2026-03-20T11:26:00.000Z',
      updatedAt: '2026-03-20T11:26:00.000Z',
      summary: '确定 session 左栏采用 agent -> sessionId -> timeline 的树状组织，并要求 agent 与 session 节点统一显示最后更新时间，而不是无助于浏览路径判断的数量统计',
    },
    {
      memoryId: 'turn:1006',
      createdAt: '2026-03-20T12:18:00.000Z',
      updatedAt: '2026-03-20T12:18:00.000Z',
      summary: '将 Muninn Board 的视觉方向收敛为白灰中性控制台，弱化大卡片和风格化包装，让界面更像一个稳定、克制、可扩展的 memory explorer 工作台',
    },
    {
      memoryId: 'turn:1007',
      createdAt: '2026-03-20T12:35:00.000Z',
      updatedAt: '2026-03-20T12:35:00.000Z',
      title: '重新评估 sidebar 与 topbar 的职责边界',
      summary: '讨论 sidebar 应该承担主导航和项目树入口，topbar 只保留全局动作，避免两个区域都在抢主导航语义',
    },
    {
      memoryId: 'turn:1008',
      createdAt: '2026-03-20T12:48:00.000Z',
      updatedAt: '2026-03-20T12:48:00.000Z',
      title: '把 Snapshots 从 Board 第一版移除',
      summary: '确认第一版 Board 只围绕 Search、LLM Wiki、Session、Settings 展开，Snapshots 不再作为一级页面或下拉选项存在',
    },
    {
      memoryId: 'turn:1009',
      createdAt: '2026-03-20T13:02:00.000Z',
      updatedAt: '2026-03-20T13:02:00.000Z',
      title: '将 Session 详情改成聊天框',
      summary: '右侧详情不再展示文档标题和面包屑，而是直接渲染 User 与 Agent 的对话气泡，保留 Markdown 能力',
    },
    {
      memoryId: 'turn:1011',
      createdAt: '2026-03-20T13:18:00.000Z',
      updatedAt: '2026-03-20T13:18:00.000Z',
      title: '收敛品牌区 logo 与 Muninn 字标',
      summary: '移除 slogan，只保留乌鸦 logo 与 Muninn 字标，调整字体、字号和间距，让品牌区更像开源项目的简洁 lockup',
    },
    {
      memoryId: 'turn:1012',
      createdAt: '2026-03-20T13:32:00.000Z',
      updatedAt: '2026-03-20T13:32:00.000Z',
      title: '把 Settings 改成内嵌页面',
      summary: 'Settings 从弹窗改为侧边栏页面，配置文件编辑器直接嵌在内容区，顶部栏不再出现重复入口',
    },
    {
      memoryId: 'turn:1013',
      createdAt: '2026-03-20T13:46:00.000Z',
      updatedAt: '2026-03-20T13:46:00.000Z',
      title: '减少页面级色块',
      summary: '将整体界面调整为白底工作台，不再使用灰底套白卡片的页面级色块，只在局部 hover、active 和聊天气泡中使用浅灰',
    },
    {
      memoryId: 'turn:1014',
      createdAt: '2026-03-20T14:00:00.000Z',
      updatedAt: '2026-03-20T14:00:00.000Z',
      title: '恢复 demo 可见性',
      summary: '让 demo 模式默认预加载并展开 session turns，避免进入页面后看不到任何样例聊天轮次',
    },
  ],
  'openclaw::board-mvp': [
    {
      memoryId: 'turn:1010',
      createdAt: '2026-03-20T11:05:00.000Z',
      updatedAt: '2026-03-20T11:05:00.000Z',
      summary: '为 Muninn Board 单独创建 packages/board 模块，明确它是独立的页面承载位，而不是继续把只读查看器能力散落在 sidecar、mcp 或其他说明文档里',
    },
  ],
  'claude_code::auth-refactor': [
    {
      memoryId: 'turn:1301',
      createdAt: '2026-03-20T13:42:00.000Z',
      updatedAt: '2026-03-20T13:42:00.000Z',
      title: '确认 auth-refactor 的接口命名',
      summary: '从 Claude Code 会话里补充确认 capture endpoint 的命名，避免 sidecar 和 board 在 session 视角上继续混用 message 与 turn 两套词。',
    },
  ],
  'claude_code::release-check': [
    {
      memoryId: 'turn:1020',
      createdAt: '2026-03-20T11:32:00.000Z',
      updatedAt: '2026-03-20T11:32:00.000Z',
      summary: '检查 MCP 命名调整对 demo 文档、说明页和演示入口的影响，确认 turn/capture、UI API 和 session snapshot read model 的表述在对外展示层面保持一致',
    },
  ],
  'codex_cli::auth-refactor': [
    {
      memoryId: 'turn:1401',
      createdAt: '2026-03-20T13:18:00.000Z',
      updatedAt: '2026-03-20T13:18:00.000Z',
      title: '补 auth-refactor 的 UI 回归点',
      summary: 'Codex 会话补充 board demo 模式下的 session tree 验证点，确保 auth-refactor 项目在多 agent 聚合后仍能稳定展开。',
    },
  ],
  'codex_cli::sdk-cleanup': [
    {
      memoryId: 'turn:1030',
      createdAt: '2026-03-20T10:41:00.000Z',
      updatedAt: '2026-03-20T10:41:00.000Z',
      summary: '清理旧 sdk 残留并确认 workspace 构建链完整，避免历史 package 和演进中的 core、sidecar、board 模块在命名和构建路径上互相干扰',
    },
  ],
  'memory_agent::auth-refactor': [
    {
      memoryId: 'turn:1501',
      createdAt: '2026-03-20T12:56:00.000Z',
      updatedAt: '2026-03-20T12:56:00.000Z',
      title: '整理 auth-refactor 的迁移备注',
      summary: 'Cursor 会话记录了 auth-refactor 中旧字段迁移的备注，用来让 demo 覆盖超过三个 agent 的 project 顶层展示。',
    },
  ],
  'memory_agent::memory-inbox/daily-recall': [
    {
      memoryId: 'turn:1601',
      createdAt: '2026-06-01T12:50:15.000Z',
      updatedAt: '2026-06-01T12:50:15.000Z',
      title: '整理今日可召回事项',
      summary: '通用 memory agent 汇总最近 24 小时内的 auth-refactor、board UI 和 agent icon 相关会话，准备作为 recall 入口的样例数据。',
    },
    {
      memoryId: 'turn:1602',
      createdAt: '2026-06-01T13:05:44.000Z',
      updatedAt: '2026-06-01T13:05:44.000Z',
      title: '抽取 session tree 的 UI 偏好',
      summary: '记录用户偏好：左栏应接近 Codex 风格，项目行更像分组，session 行像可打开文档，agent 图标适配应封装在 asset 内部。',
    },
    {
      memoryId: 'turn:1603',
      createdAt: '2026-06-01T13:18:27.000Z',
      updatedAt: '2026-06-01T13:18:27.000Z',
      title: '生成 fallback agent 展示数据',
      summary: '补充未适配 agent 的演示会话，使用通用 Bot 图标展示未知 agent，避免只有 Claude、Codex、OpenClaw 三类品牌图标。',
    },
    {
      memoryId: 'turn:1604',
      createdAt: '2026-06-01T13:25:02.000Z',
      updatedAt: '2026-06-01T13:25:02.000Z',
      title: '校正 turn 时间显示规则',
      summary: '将 24 小时内的 turn 时间显示为时分秒，超过 24 小时的 turn 继续使用短相对时间，让 session tree 更接近 Codex 左栏的信息密度。',
    },
    {
      memoryId: 'turn:1605',
      createdAt: '2026-06-01T13:32:00.000Z',
      updatedAt: '2026-06-01T13:32:00.000Z',
      title: 'Markdown 渲染样例',
      summary: '补充一条专门覆盖 Markdown 渲染的 demo turn，包含代码块、表格、列表、引用和 inline code，用来检查聊天气泡内的排版与溢出控制。',
    },
  ],
};

export const demoDocuments: Record<string, DemoMemoryDocument> = {
  'turn:1001': {
    memoryId: 'turn:1001',
    kind: 'turn',
    title: '完成 sidecar 写入口从 message/add 收敛到 turn/capture',
    agent: 'openclaw',
    sessionId: 'auth-refactor',
    updatedAt: '2026-03-20T10:12:00.000Z',
    markdown: `# turn:1001

## Context

- Agent: openclaw
- Session: auth-refactor
- Created At: 2026-03-20T10:12:00.000Z
- Updated At: 2026-03-20T10:12:00.000Z

## Summary

完成 sidecar 写入口从 \`message/add\` 收敛到 \`turn/capture\`

## Prompt

将当前主写入口收敛为 POST /api/v1/turn/capture

## Response

完成路由、命名、测试和文档同步`,
  },
  'turn:1002': {
    memoryId: 'turn:1002',
    kind: 'turn',
    title: '确认 extra 只保留在接口层，不进入稳定 format',
    agent: 'openclaw',
    sessionId: 'auth-refactor',
    updatedAt: '2026-03-20T10:27:00.000Z',
    markdown: `# turn:1002

## Context

- Agent: openclaw
- Session: auth-refactor
- Created At: 2026-03-20T10:27:00.000Z
- Updated At: 2026-03-20T10:27:00.000Z

## Summary

确认 extra 只保留在接口层，不进入稳定 format

## Tool Calling

- normalize-request
- align-sidecar-contract`,
  },
  'turn:1003': {
    memoryId: 'turn:1003',
    kind: 'turn',
    title: '补 sidecar 写接口和读链路回归测试',
    agent: 'openclaw',
    sessionId: 'auth-refactor',
    updatedAt: '2026-03-20T10:41:00.000Z',
    markdown: `# turn:1003

## Context

- Agent: openclaw
- Session: auth-refactor
- Created At: 2026-03-20T10:41:00.000Z
- Updated At: 2026-03-20T10:41:00.000Z

## Summary

补 sidecar 写接口和读链路回归测试

## Tool Artifacts

- suite: session_flow
- status: passed`,
  },
  'turn:1004': {
    memoryId: 'turn:1004',
    kind: 'turn',
    title: '开始搭建 Muninn Board 的页面承载位与最小信息架构',
    agent: 'openclaw',
    sessionId: 'auth-refactor',
    updatedAt: '2026-03-20T11:05:00.000Z',
    markdown: `# turn:1004

## Context

- Agent: openclaw
- Session: auth-refactor
- Created At: 2026-03-20T11:05:00.000Z
- Updated At: 2026-03-20T11:05:00.000Z

## Summary

开始搭建 Muninn Board 的页面承载位与最小信息架构

## Response

先把页面结构和信息层级站住，再接 sidecar 的真实 UI API`,
  },
  'turn:1005': {
    memoryId: 'turn:1005',
    kind: 'turn',
    title: '确定 session 左栏采用 agent -> sessionId -> timeline 的树状组织',
    agent: 'openclaw',
    sessionId: 'auth-refactor',
    updatedAt: '2026-03-20T11:26:00.000Z',
    markdown: `# turn:1005

## Context

- Agent: openclaw
- Session: auth-refactor
- Created At: 2026-03-20T11:26:00.000Z
- Updated At: 2026-03-20T11:26:00.000Z

## Summary

确定 session 左栏采用 agent -> sessionId -> timeline 的树状组织

## Prompt

我希望整个界面简洁大气，有简洁，高效，舒服的气质`,
  },
  'turn:1006': {
    memoryId: 'turn:1006',
    kind: 'turn',
    title: '将 Muninn Board 的视觉方向收敛为白灰中性控制台',
    agent: 'openclaw',
    sessionId: 'auth-refactor',
    updatedAt: '2026-03-20T12:18:00.000Z',
    markdown: `# turn:1006

## Context

- Agent: openclaw
- Session: auth-refactor
- Created At: 2026-03-20T12:18:00.000Z
- Updated At: 2026-03-20T12:18:00.000Z

## Summary

将 Muninn Board 的视觉方向收敛为白灰中性控制台

## Response

顶部栏保留，主体改为左右平铺工作台，中间可拖拽`,
  },
  'turn:1007': {
    memoryId: 'turn:1007',
    kind: 'turn',
    title: '重新评估 sidebar 与 topbar 的职责边界',
    agent: 'openclaw',
    sessionId: 'auth-refactor',
    updatedAt: '2026-03-20T12:35:00.000Z',
    markdown: `# turn:1007

## Prompt

上边栏和侧边栏排版你觉得合适吗，我觉得有些别扭

## Response

我会把 sidebar 当成主导航，把折叠控制也放回到更稳定的位置。topbar 只保留全局动作，不再显示跟随菜单变化的标题。

这样 sidebar 和 topbar 的职责会更清楚：

- sidebar: logo、导航、project/session tree
- topbar: GitHub、版本、未来全局动作
- content: 当前页面的实际工作区`,
  },
  'turn:1008': {
    memoryId: 'turn:1008',
    kind: 'turn',
    title: '把 Snapshots 从 Board 第一版移除',
    agent: 'openclaw',
    sessionId: 'auth-refactor',
    updatedAt: '2026-03-20T12:48:00.000Z',
    markdown: `# turn:1008

## Prompt

SNAPSHOT 这个我不要了，给我干掉，那个下拉框也不要了

## Response

已按第一版信息架构收敛：左侧只保留 Search、LLM Wiki、Session、Settings。

Snapshots 不再作为可见入口出现，原来的下拉也移除。观察类数据后续如果要回归，应该进入 LLM Wiki 或独立的 memory layer 设计，而不是挤在 Session 页面里。`,
  },
  'turn:1009': {
    memoryId: 'turn:1009',
    kind: 'turn',
    title: '将 Session 详情改成聊天框',
    agent: 'openclaw',
    sessionId: 'auth-refactor',
    updatedAt: '2026-03-20T13:02:00.000Z',
    markdown: `# turn:1009

## Prompt

右边展示的也不要有什么标题，就是个聊天框的交互方式，这块不要管之前怎么做的

## Response

Session turn 的详情区改成 chat-only view：

- 不显示 document title
- 不显示 breadcrumb
- User 消息靠左
- Agent 消息靠右
- 气泡内部仍然支持 Markdown

如果 turn 里没有明确的 Prompt/Response，也会 fallback 成一条 memory message，避免空白。`,
  },
  'turn:1011': {
    memoryId: 'turn:1011',
    kind: 'turn',
    title: '收敛品牌区 logo 与 Muninn 字标',
    agent: 'openclaw',
    sessionId: 'auth-refactor',
    updatedAt: '2026-03-20T13:18:00.000Z',
    markdown: `# turn:1011

## Prompt

我希望你用这个 logo + Muninn 项目名称先给我做个整体的 slogan，这个现在看起来字体和 logo 不协调

## Response

品牌区先收敛为更克制的 logo lockup：

- 乌鸦图标保持原图风格
- Muninn 使用偏古典的 serif 字体
- 移除过多辅助文字
- 控制 logo、字标、菜单之间的距离

这比额外加 slogan 更适合现在的工具型界面。`,
  },
  'turn:1012': {
    memoryId: 'turn:1012',
    kind: 'turn',
    title: '把 Settings 改成内嵌页面',
    agent: 'openclaw',
    sessionId: 'auth-refactor',
    updatedAt: '2026-03-20T13:32:00.000Z',
    markdown: `# turn:1012

## Prompt

Settings 已经移到左边栏，上边栏就不要了。Settings 既然已经是侧边栏了，就不要弹出页面了，而是嵌入到内容页里展示配置和更新配置

## Response

Settings 现在是一个普通内容页：

- 入口只在 sidebar
- 顶部栏不再重复出现 Settings
- 配置文件编辑器直接在主内容区展示
- Edit/Save 保留原来的校验和保存逻辑`,
  },
  'turn:1013': {
    memoryId: 'turn:1013',
    kind: 'turn',
    title: '减少页面级色块',
    agent: 'openclaw',
    sessionId: 'auth-refactor',
    updatedAt: '2026-03-20T13:46:00.000Z',
    markdown: `# turn:1013

## Prompt

当前内容整个色块我觉得不好看，尤其内容页，我不太主张这样的色块，能不能不要色块，直接基于白色背景搞？

## Response

整体改成白底工作台：

- 去掉灰底大背景
- 去掉内容区外层大卡片
- 保留必要分隔线
- hover、active、聊天气泡这类局部层级才使用浅灰

这样页面会更轻，也更接近 shadcn dashboard 的实用工具感。`,
  },
  'turn:1014': {
    memoryId: 'turn:1014',
    kind: 'turn',
    title: '恢复 demo 可见性',
    agent: 'openclaw',
    sessionId: 'auth-refactor',
    updatedAt: '2026-03-20T14:00:00.000Z',
    markdown: `# turn:1014

## Prompt

现在 session 啥也看不到，demo 数据呢，另外 demo 数据里多造一些聊天的轮次

## Response

Demo 模式会默认预加载 session turns，并展开 session 内容。

同时补充了一组围绕 Board UI 迭代的聊天轮次，让左侧列表和右侧 chat view 都有更接近真实产品使用的样例内容。`,
  },
  'turn:1010': {
    memoryId: 'turn:1010',
    kind: 'turn',
    title: '为 Muninn Board 单独创建 packages/board 模块',
    agent: 'openclaw',
    sessionId: 'board-mvp',
    updatedAt: '2026-03-20T11:05:00.000Z',
    markdown: `# turn:1010

## Context

- Agent: openclaw
- Session: board-mvp
- Created At: 2026-03-20T11:05:00.000Z
- Updated At: 2026-03-20T11:05:00.000Z

## Summary

为 Muninn Board 单独创建 packages/board 模块`,
  },
  'turn:1020': {
    memoryId: 'turn:1020',
    kind: 'turn',
    title: '检查 MCP 命名调整对 demo 文档和说明页的影响',
    agent: 'claude_code',
    sessionId: 'release-check',
    updatedAt: '2026-03-20T11:32:00.000Z',
    markdown: `# turn:1020

## Context

- Agent: claude_code
- Session: release-check
- Created At: 2026-03-20T11:32:00.000Z
- Updated At: 2026-03-20T11:32:00.000Z

## Summary

检查 MCP 命名调整对 demo 文档和说明页的影响`,
  },
  'turn:1030': {
    memoryId: 'turn:1030',
    kind: 'turn',
    title: '清理旧 sdk 残留并确认 workspace 构建链完整',
    agent: 'codex_cli',
    sessionId: 'sdk-cleanup',
    updatedAt: '2026-03-20T10:41:00.000Z',
    markdown: `# turn:1030

## Context

- Agent: codex_cli
- Session: sdk-cleanup
- Created At: 2026-03-20T10:41:00.000Z
- Updated At: 2026-03-20T10:41:00.000Z

## Summary

清理旧 sdk 残留并确认 workspace 构建链完整`,
  },
  'turn:1601': {
    memoryId: 'turn:1601',
    kind: 'turn',
    title: '整理今日可召回事项',
    agent: 'memory_agent',
    sessionId: 'memory-inbox/daily-recall',
    updatedAt: '2026-06-01T12:50:15.000Z',
    markdown: `# turn:1601

## Prompt

把今天 board 相关的关键上下文整理成可召回事项。

## Response

已汇总最近 24 小时内的 auth-refactor、board UI 和 agent icon 相关会话，作为 recall 入口的样例数据。`,
  },
  'turn:1602': {
    memoryId: 'turn:1602',
    kind: 'turn',
    title: '抽取 session tree 的 UI 偏好',
    agent: 'memory_agent',
    sessionId: 'memory-inbox/daily-recall',
    updatedAt: '2026-06-01T13:05:44.000Z',
    markdown: `# turn:1602

## Prompt

提炼用户对 session tree 的 UI 偏好。

## Response

用户偏好接近 Codex 左栏：项目行更像分组，session 行像可打开文档，agent 图标适配应封装在 asset 内部。`,
  },
  'turn:1603': {
    memoryId: 'turn:1603',
    kind: 'turn',
    title: '生成 fallback agent 展示数据',
    agent: 'memory_agent',
    sessionId: 'memory-inbox/daily-recall',
    updatedAt: '2026-06-01T13:18:27.000Z',
    markdown: `# turn:1603

## Prompt

补一组未适配 agent 的演示数据。

## Response

已创建 memory_agent 会话，用通用 Bot 图标展示未知 agent，避免 demo 只覆盖 Claude、Codex、OpenClaw 三类品牌图标。`,
  },
  'turn:1604': {
    memoryId: 'turn:1604',
    kind: 'turn',
    title: '校正 turn 时间显示规则',
    agent: 'memory_agent',
    sessionId: 'memory-inbox/daily-recall',
    updatedAt: '2026-06-01T13:25:02.000Z',
    markdown: `# turn:1604

## Prompt

调整 turn 行的时间显示。

## Response

24 小时内的 turn 显示为时分秒；超过 24 小时的 turn 继续使用短相对时间。时间移动到摘要右侧，便于横向扫描。`,
  },
  'turn:1605': {
    memoryId: 'turn:1605',
    kind: 'turn',
    title: 'Markdown 渲染样例',
    agent: 'memory_agent',
    sessionId: 'memory-inbox/daily-recall',
    updatedAt: '2026-06-01T13:32:00.000Z',
    markdown: `# turn:1605

## Prompt

给聊天框补一个 Markdown 渲染样例，我想看代码块、表格、列表和引用在气泡里的效果。

## Response

可以。下面是一个覆盖常见聊天内容的 Markdown 样例。

### 列表

- 支持普通无序列表
- 支持 \`inline code\`、路径和配置项，比如 \`packages/board/src/components/ChatView.tsx\`
- 长文本会在气泡内部换行，不应该跳出容器

1. 先从 session tree 选择一个 turn
2. 右侧渲染完整 transcript
3. Markdown 内容保持在聊天气泡内

### 代码块

\`\`\`ts
type MemoryTurn = {
  memoryId: string;
  agent: 'openclaw' | 'claude_code' | 'codex_cli' | 'memory_agent';
  summary: string;
};

export function renderTurn(turn: MemoryTurn) {
  return \`\${turn.agent}: \${turn.summary}\`;
}
\`\`\`

### 表格

| Area | Markdown feature | Expected behavior |
| --- | --- | --- |
| Chat bubble | Code block | Keep readable spacing and stay inside the bubble |
| Chat bubble | Table | Render as a table and scroll horizontally if too wide |
| Session tree | Summary text | Show up to three lines, then truncate |

### 引用

> Memory UI should preserve the original conversation shape, but still make structured content easy to scan.

### 长 token

\`muninn://session/memory-inbox/daily-recall/turn/1605/this-is-a-long-reference-that-should-wrap-inside-the-chat-bubble\``,
  },
  'session:2001': {
    memoryId: 'session:2001',
    kind: 'session',
    title: '写接口命名已经稳定到 turn/capture',
    updatedAt: '2026-03-20T12:30:00.000Z',
    markdown: `# session:2001

## Session Memory

写接口已经从历史的 message/add 收敛到 turn/capture，接口语义转为“一次提交一条完整 turn”

## Reasoning

这个命名让 sidecar 的写入语义更清楚，也更适合后续把 session 看成逻辑归属容器，而不是一次性提交的完整会话对象

## Notes

- 相关改动已经覆盖到测试和文档
- 当前 extra 仍然只保留在接口层`,
  },
  'session:2002': {
    memoryId: 'session:2002',
    kind: 'session',
    title: 'Muninn Board 应该采用控制台而不是小而美的展示页方向',
    updatedAt: '2026-03-20T12:48:00.000Z',
    markdown: `# session:2002

## Session Memory

Muninn Board 更适合作为 memory explorer/workbench，而不是概念展示页

## Reasoning

当前项目定位是 memory format 和生态位，不是靠产品包装取胜的小工具。界面应该强调浏览效率、信息密度和可检查性

## Notes

- 配色应以白灰中性为主
- 左栏和右栏应明确分工
- detail 区未来需要自然演进到编辑态`,
  },
};

export const demoSessionSnapshots: DemoSessionSnapshotListItem[] = [
  {
    memoryId: 'session:2002',
    title: 'Muninn Board 应该采用控制台而不是小而美的展示页方向',
    summary: 'Muninn 作为 memory format 和生态位项目，不适合继续沿用偏卡片、偏展示页的小而美思路。更合理的方向是白灰中性、左右平铺、以 explorer 和文档阅读为核心的控制台式界面，这样可以为后续扩展 session snapshots、editing 和更多 memory layer 预留空间',
    updatedAt: '2026-03-20T12:48:00.000Z',
    references: [
      {
        memoryId: 'turn:1006',
        timestamp: '2026-03-20T12:18:00.000Z',
        summary: '将 Muninn Board 的视觉方向收敛为白灰中性控制台',
      },
      {
        memoryId: 'turn:1005',
        timestamp: '2026-03-20T11:26:00.000Z',
        summary: '确定 session 左栏采用 agent -> sessionId -> timeline 的树状组织',
      },
    ],
  },
  {
    memoryId: 'session:2001',
    title: '写接口命名已经稳定到 turn/capture',
    summary: 'sidecar 的主写入口已经稳定到 turn/capture，接口语言从“写一个 session memory row”收敛到“一次提交一条完整 turn”。这一点能帮助后续 session memory extraction和 OpenClaw 精炼记忆的建模保持清晰',
    updatedAt: '2026-03-20T12:30:00.000Z',
    references: [
      {
        memoryId: 'turn:1001',
        timestamp: '2026-03-20T10:12:00.000Z',
        summary: '完成 sidecar 写入口从 message/add 收敛到 turn/capture',
      },
      {
        memoryId: 'turn:1002',
        timestamp: '2026-03-20T10:27:00.000Z',
        summary: '确认 extra 只保留在接口层，不进入稳定 format',
      },
    ],
  },
];
