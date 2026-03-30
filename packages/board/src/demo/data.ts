export type DemoSessionAgentItem = {
  agent: string;
  latestUpdatedAt: string;
};

export type DemoSessionGroupItem = {
  sessionKey: string;
  displaySessionId: string;
  latestUpdatedAt: string;
};

export type DemoSessionTimelineItem = {
  memoryId: string;
  createdAt: string;
  updatedAt: string;
  summary: string;
};

export type DemoObservingReferenceItem = {
  memoryId: string;
  timestamp: string;
  summary: string;
};

export type DemoObservingListItem = {
  memoryId: string;
  title: string;
  summary: string;
  updatedAt: string;
  references: DemoObservingReferenceItem[];
};

export type DemoMemoryDocument = {
  memoryId: string;
  kind: 'session' | 'observing';
  title: string;
  markdown: string;
  agent?: string;
  sessionId?: string;
  updatedAt?: string;
};

export const demoAgents: DemoSessionAgentItem[] = [
  { agent: 'openclaw', latestUpdatedAt: '2026-03-20T12:18:00.000Z' },
  { agent: 'claude_code', latestUpdatedAt: '2026-03-20T11:32:00.000Z' },
  { agent: 'codex_cli', latestUpdatedAt: '2026-03-20T10:41:00.000Z' },
];

export const demoSessionGroups: Record<string, DemoSessionGroupItem[]> = {
  openclaw: [
    { sessionKey: 'auth-refactor', displaySessionId: 'auth-refactor', latestUpdatedAt: '2026-03-20T12:18:00.000Z' },
    { sessionKey: 'board-mvp', displaySessionId: 'board-mvp', latestUpdatedAt: '2026-03-20T11:05:00.000Z' },
  ],
  claude_code: [
    { sessionKey: 'release-check', displaySessionId: 'release-check', latestUpdatedAt: '2026-03-20T11:32:00.000Z' },
  ],
  codex_cli: [
    { sessionKey: 'sdk-cleanup', displaySessionId: 'sdk-cleanup', latestUpdatedAt: '2026-03-20T10:41:00.000Z' },
  ],
};

export const demoSessionTurns: Record<string, DemoSessionTimelineItem[]> = {
  'openclaw::auth-refactor': [
    {
      memoryId: 'SESSION:01KM5DEMO0001',
      createdAt: '2026-03-20T10:12:00.000Z',
      updatedAt: '2026-03-20T10:12:00.000Z',
      summary: '完成 sidecar 写入口从历史的 message/add 收敛到 session/messages，并同步校正文档、类型命名和测试描述，让对外语义明确变成向某个 session 添加一条 message',
    },
    {
      memoryId: 'SESSION:01KM5DEMO0002',
      createdAt: '2026-03-20T10:27:00.000Z',
      updatedAt: '2026-03-20T10:27:00.000Z',
      summary: '确认 extra 只保留在接口传输层，由 sidecar 适配逻辑按需消费，不进入 Rust format、Lance schema、recall 和 detail 渲染，避免污染稳定持久化协议',
    },
    {
      memoryId: 'SESSION:01KM5DEMO0003',
      createdAt: '2026-03-20T10:41:00.000Z',
      updatedAt: '2026-03-20T10:41:00.000Z',
      summary: '补 sidecar 写接口和读链路回归测试，覆盖 prompt-only、response-only、tool-only、extra 校验以及写后通过 detail、timeline、recall 回读的主流程行为',
    },
    {
      memoryId: 'SESSION:01KM5DEMO0004',
      createdAt: '2026-03-20T11:05:00.000Z',
      updatedAt: '2026-03-20T11:05:00.000Z',
      summary: '开始搭建 Munnai Board 的页面承载位与最小信息架构，先把顶栏、左右分栏、详情文档区和模式切换稳定下来，再逐步接入真实 sidecar UI API',
    },
    {
      memoryId: 'SESSION:01KM5DEMO0005',
      createdAt: '2026-03-20T11:26:00.000Z',
      updatedAt: '2026-03-20T11:26:00.000Z',
      summary: '确定 session 左栏采用 agent -> session_id -> timeline 的树状组织，并要求 agent 与 session 节点统一显示最后更新时间，而不是无助于浏览路径判断的数量统计',
    },
    {
      memoryId: 'SESSION:01KM5DEMO0006',
      createdAt: '2026-03-20T12:18:00.000Z',
      updatedAt: '2026-03-20T12:18:00.000Z',
      summary: '将 Munnai Board 的视觉方向收敛为白灰中性控制台，弱化大卡片和风格化包装，让界面更像一个稳定、克制、可扩展的 memory explorer 工作台',
    },
  ],
  'openclaw::board-mvp': [
    {
      memoryId: 'SESSION:01KM5DEMO0010',
      createdAt: '2026-03-20T11:05:00.000Z',
      updatedAt: '2026-03-20T11:05:00.000Z',
      summary: '为 Munnai Board 单独创建 packages/board 模块，明确它是独立的页面承载位，而不是继续把只读查看器能力散落在 sidecar、mcp 或其他说明文档里',
    },
  ],
  'claude_code::release-check': [
    {
      memoryId: 'SESSION:01KM5DEMO0020',
      createdAt: '2026-03-20T11:32:00.000Z',
      updatedAt: '2026-03-20T11:32:00.000Z',
      summary: '检查 MCP 命名调整对 demo 文档、说明页和演示入口的影响，确认 session/messages、UI API 和 observing read model 的表述在对外展示层面保持一致',
    },
  ],
  'codex_cli::sdk-cleanup': [
    {
      memoryId: 'SESSION:01KM5DEMO0030',
      createdAt: '2026-03-20T10:41:00.000Z',
      updatedAt: '2026-03-20T10:41:00.000Z',
      summary: '清理旧 sdk 残留并确认 workspace 构建链完整，避免历史 package 和演进中的 core、sidecar、board 模块在命名和构建路径上互相干扰',
    },
  ],
};

export const demoDocuments: Record<string, DemoMemoryDocument> = {
  'SESSION:01KM5DEMO0001': {
    memoryId: 'SESSION:01KM5DEMO0001',
    kind: 'session',
    title: '完成 sidecar 写入口从 message/add 收敛到 session/messages',
    agent: 'openclaw',
    sessionId: 'auth-refactor',
    updatedAt: '2026-03-20T10:12:00.000Z',
    markdown: `# SESSION:01KM5DEMO0001

## Context

- Agent: openclaw
- Session: auth-refactor
- Created At: 2026-03-20T10:12:00.000Z
- Updated At: 2026-03-20T10:12:00.000Z

## Summary

完成 sidecar 写入口从 \`message/add\` 收敛到 \`session/messages\`

## Prompt

将当前主写入口收敛为 POST /api/v1/session/messages

## Response

完成路由、命名、测试和文档同步`,
  },
  'SESSION:01KM5DEMO0002': {
    memoryId: 'SESSION:01KM5DEMO0002',
    kind: 'session',
    title: '确认 extra 只保留在接口层，不进入稳定 format',
    agent: 'openclaw',
    sessionId: 'auth-refactor',
    updatedAt: '2026-03-20T10:27:00.000Z',
    markdown: `# SESSION:01KM5DEMO0002

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
  'SESSION:01KM5DEMO0003': {
    memoryId: 'SESSION:01KM5DEMO0003',
    kind: 'session',
    title: '补 sidecar 写接口和读链路回归测试',
    agent: 'openclaw',
    sessionId: 'auth-refactor',
    updatedAt: '2026-03-20T10:41:00.000Z',
    markdown: `# SESSION:01KM5DEMO0003

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
  'SESSION:01KM5DEMO0004': {
    memoryId: 'SESSION:01KM5DEMO0004',
    kind: 'session',
    title: '开始搭建 Munnai Board 的页面承载位与最小信息架构',
    agent: 'openclaw',
    sessionId: 'auth-refactor',
    updatedAt: '2026-03-20T11:05:00.000Z',
    markdown: `# SESSION:01KM5DEMO0004

## Context

- Agent: openclaw
- Session: auth-refactor
- Created At: 2026-03-20T11:05:00.000Z
- Updated At: 2026-03-20T11:05:00.000Z

## Summary

开始搭建 Munnai Board 的页面承载位与最小信息架构

## Response

先把页面结构和信息层级站住，再接 sidecar 的真实 UI API`,
  },
  'SESSION:01KM5DEMO0005': {
    memoryId: 'SESSION:01KM5DEMO0005',
    kind: 'session',
    title: '确定 session 左栏采用 agent -> session_id -> timeline 的树状组织',
    agent: 'openclaw',
    sessionId: 'auth-refactor',
    updatedAt: '2026-03-20T11:26:00.000Z',
    markdown: `# SESSION:01KM5DEMO0005

## Context

- Agent: openclaw
- Session: auth-refactor
- Created At: 2026-03-20T11:26:00.000Z
- Updated At: 2026-03-20T11:26:00.000Z

## Summary

确定 session 左栏采用 agent -> session_id -> timeline 的树状组织

## Prompt

我希望整个界面简洁大气，有简洁，高效，舒服的气质`,
  },
  'SESSION:01KM5DEMO0006': {
    memoryId: 'SESSION:01KM5DEMO0006',
    kind: 'session',
    title: '将 Munnai Board 的视觉方向收敛为白灰中性控制台',
    agent: 'openclaw',
    sessionId: 'auth-refactor',
    updatedAt: '2026-03-20T12:18:00.000Z',
    markdown: `# SESSION:01KM5DEMO0006

## Context

- Agent: openclaw
- Session: auth-refactor
- Created At: 2026-03-20T12:18:00.000Z
- Updated At: 2026-03-20T12:18:00.000Z

## Summary

将 Munnai Board 的视觉方向收敛为白灰中性控制台

## Response

顶部栏保留，主体改为左右平铺工作台，中间可拖拽`,
  },
  'SESSION:01KM5DEMO0010': {
    memoryId: 'SESSION:01KM5DEMO0010',
    kind: 'session',
    title: '为 Munnai Board 单独创建 packages/board 模块',
    agent: 'openclaw',
    sessionId: 'board-mvp',
    updatedAt: '2026-03-20T11:05:00.000Z',
    markdown: `# SESSION:01KM5DEMO0010

## Context

- Agent: openclaw
- Session: board-mvp
- Created At: 2026-03-20T11:05:00.000Z
- Updated At: 2026-03-20T11:05:00.000Z

## Summary

为 Munnai Board 单独创建 packages/board 模块`,
  },
  'SESSION:01KM5DEMO0020': {
    memoryId: 'SESSION:01KM5DEMO0020',
    kind: 'session',
    title: '检查 MCP 命名调整对 demo 文档和说明页的影响',
    agent: 'claude_code',
    sessionId: 'release-check',
    updatedAt: '2026-03-20T11:32:00.000Z',
    markdown: `# SESSION:01KM5DEMO0020

## Context

- Agent: claude_code
- Session: release-check
- Created At: 2026-03-20T11:32:00.000Z
- Updated At: 2026-03-20T11:32:00.000Z

## Summary

检查 MCP 命名调整对 demo 文档和说明页的影响`,
  },
  'SESSION:01KM5DEMO0030': {
    memoryId: 'SESSION:01KM5DEMO0030',
    kind: 'session',
    title: '清理旧 sdk 残留并确认 workspace 构建链完整',
    agent: 'codex_cli',
    sessionId: 'sdk-cleanup',
    updatedAt: '2026-03-20T10:41:00.000Z',
    markdown: `# SESSION:01KM5DEMO0030

## Context

- Agent: codex_cli
- Session: sdk-cleanup
- Created At: 2026-03-20T10:41:00.000Z
- Updated At: 2026-03-20T10:41:00.000Z

## Summary

清理旧 sdk 残留并确认 workspace 构建链完整`,
  },
  'OBSERVING:01KM5OBS0001': {
    memoryId: 'OBSERVING:01KM5OBS0001',
    kind: 'observing',
    title: '写接口命名已经稳定到 session/messages',
    updatedAt: '2026-03-20T12:30:00.000Z',
    markdown: `# OBSERVING:01KM5OBS0001

## Observing

写接口已经从历史的 message/add 收敛到 session/messages，接口语义转为“向某个 session 添加一条 message”

## Reasoning

这个命名让 sidecar 的写入语义更清楚，也更适合后续把 session 看成逻辑归属容器，而不是一次性提交的完整会话对象

## Notes

- 相关改动已经覆盖到测试和文档
- 当前 extra 仍然只保留在接口层`,
  },
  'OBSERVING:01KM5OBS0002': {
    memoryId: 'OBSERVING:01KM5OBS0002',
    kind: 'observing',
    title: 'Munnai Board 应该采用控制台而不是小而美的展示页方向',
    updatedAt: '2026-03-20T12:48:00.000Z',
    markdown: `# OBSERVING:01KM5OBS0002

## Observing

Munnai Board 更适合作为 memory explorer/workbench，而不是概念展示页

## Reasoning

当前项目定位是 memory format 和生态位，不是靠产品包装取胜的小工具。界面应该强调浏览效率、信息密度和可检查性

## Notes

- 配色应以白灰中性为主
- 左栏和右栏应明确分工
- detail 区未来需要自然演进到编辑态`,
  },
};

export const demoObservings: DemoObservingListItem[] = [
  {
    memoryId: 'OBSERVING:01KM5OBS0002',
    title: 'Munnai Board 应该采用控制台而不是小而美的展示页方向',
    summary: 'Munnai 作为 memory format 和生态位项目，不适合继续沿用偏卡片、偏展示页的小而美思路。更合理的方向是白灰中性、左右平铺、以 explorer 和文档阅读为核心的控制台式界面，这样可以为后续扩展 observing、editing 和更多 memory layer 预留空间',
    updatedAt: '2026-03-20T12:48:00.000Z',
    references: [
      {
        memoryId: 'SESSION:01KM5DEMO0006',
        timestamp: '2026-03-20T12:18:00.000Z',
        summary: '将 Munnai Board 的视觉方向收敛为白灰中性控制台',
      },
      {
        memoryId: 'SESSION:01KM5DEMO0005',
        timestamp: '2026-03-20T11:26:00.000Z',
        summary: '确定 session 左栏采用 agent -> session_id -> timeline 的树状组织',
      },
    ],
  },
  {
    memoryId: 'OBSERVING:01KM5OBS0001',
    title: '写接口命名已经稳定到 session/messages',
    summary: 'sidecar 的主写入口已经稳定到 session/messages，接口语言从“写一个 session memory row”收敛到“向某个 session 添加一条 message”。这一点能帮助后续 observing 蒸馏和 OpenClaw 精炼记忆的建模保持清晰',
    updatedAt: '2026-03-20T12:30:00.000Z',
    references: [
      {
        memoryId: 'SESSION:01KM5DEMO0001',
        timestamp: '2026-03-20T10:12:00.000Z',
        summary: '完成 sidecar 写入口从 message/add 收敛到 session/messages',
      },
      {
        memoryId: 'SESSION:01KM5DEMO0002',
        timestamp: '2026-03-20T10:27:00.000Z',
        summary: '确认 extra 只保留在接口层，不进入稳定 format',
      },
    ],
  },
];
