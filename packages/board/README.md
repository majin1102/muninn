# Muninn Board

`@muninn/board` 是 Muninn Board 的页面承载模块。

当前阶段目标：

- 为 Muninn Board 提供独立的前端落点
- 先把 MVP 1 的最小信息架构跑起来
- 接入真实的 sidecar session / observation 数据，并持续打磨只读查看体验

当前实现：

- 左右工作台布局
- `session / observation` 切换
- `Live / Demo` 数据模式切换
- `session` 树状 explorer
- `observation` 摘要 block 列表
- 右侧 markdown 文档详情区
- Settings 弹窗，可查看和保存 `${MUNINN_HOME}/settings.json`
- `board` 自己维护人类向 UI 路由与页面静态资源
- 运行时由 `@muninn/sidecar` 统一挂载到 `/board/`

`settings.json` 里的配置目前支持：

```json
{
  "storage": {
    "uri": "s3://my-bucket/muninn",
    "storageOptions": {
      "region": "ap-southeast-1"
    }
  },
  "turn": {
    "llm": "default_turn_llm",
    "llmSummaryThresholdChars": 640,
    "titleMaxChars": 120
  },
  "observer": {
    "name": "default-observer",
    "llm": "default_observer_llm",
    "maxAttempts": 3
  },
  "semanticIndex": {
    "embedding": {
      "provider": "openai",
      "model": "text-embedding-3-small",
      "apiKey": "sk-...",
      "baseUrl": "https://api.openai.com/v1",
      "dimensions": 1536
    },
    "defaultImportance": 0.7
  },
  "watchdog": {
    "enabled": true,
    "intervalMs": 60000,
    "compactMinFragments": 8,
    "semanticIndex": {
      "targetPartitionSize": 1024,
      "optimizeMergeCount": 4
    }
  },
  "llm": {
    "default_turn_llm": {
      "provider": "openai",
      "model": "gpt-5.4-mini",
      "api": "responses",
      "apiKey": "sk-...",
      "baseUrl": "https://api.openai.com/v1"
    },
    "default_observer_llm": {
      "provider": "openai",
      "model": "gpt-5.4-mini",
      "api": "responses",
      "apiKey": "sk-...",
      "baseUrl": "https://api.openai.com/v1"
    }
  }
}
```

- `storage` 缺省时，Muninn 默认使用本地 `MUNINN_HOME`
- `storage.uri` 可以切到 `s3://...` 等对象存储前缀
- `storage.storageOptions` 会透传给 Lance/object_store 初始化底层存储后端
- `turn.llmSummaryThresholdChars` 决定 turn 在多长输入下切换到 LLM summary 路径
- `turn.titleMaxChars` 控制 turn title 的最大长度
- `observer.maxAttempts` 会同时作用于 observing gateway 和 observing update 的 LLM 重试次数
- `semanticIndex` 相关配置也统一使用 camelCase，例如 `semanticIndex.embedding.apiKey` 和 `semanticIndex.defaultImportance`
- `watchdog.enabled=false` 会关闭启动检查和后台维护
- `watchdog.intervalMs` 控制 watchdog 的维护间隔
- `watchdog.compactMinFragments` 控制 `turn / observing / semanticIndex` 触发 compaction 的最小 fragment 数
- `watchdog.semanticIndex.targetPartitionSize` 用于计算 `semantic_index` 向量索引的 IVF 分区数
- `watchdog.semanticIndex.optimizeMergeCount` 控制每次索引优化最多合并多少个增量索引段，值越大单次维护越重，但索引碎片通常更少
- Board 在 `settings.json` 不存在时会给出一份默认模板，其中包含 watchdog 默认配置
- `semantic_index` 的向量索引会在 watchdog 启动检查或后续维护中自动补建；如果 dataset 还是空表，会等第一批 row 写入后再建索引

当前状态：

- Muninn Board 的基础前端功能已经基本完成
- 当前主要未完成项是 logo / 品牌标识，以及少量视觉与交互细节收尾

Demo 模式：

- 可以通过顶部 `Demo` 开关启用
- 也可以通过 URL `?demo=1` 进入
- demo 数据保存在仓库内的前端 fixture 中，不会写入真实 Lance 数据集

构建：

```bash
pnpm --filter @muninn/board build
```

运行：

```bash
pnpm --filter @muninn/sidecar start
```

然后访问：

```text
http://localhost:8080/board/
```
