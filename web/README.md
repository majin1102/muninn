# Muninn Web

`@muninn/web` 是 Muninn 的 browser/WKWebView UI。

当前实现：

- 左右工作台布局
- `Session / Extraction` 信息视图
- `Live / Demo` 数据模式切换
- session explorer、search、pipeline、settings 等主要页面
- 右侧 markdown 详情区
- Settings 弹窗，可查看和保存 `${MUNINN_HOME}/muninn.json`
- 运行时由 `@muninn/server` 挂载到 `/app/`

`muninn.json` 的核心配置形状：

```json
{
  "storage": {
    "uri": "s3://my-bucket/muninn",
    "storageOptions": {
      "region": "ap-southeast-1"
    }
  },
  "extractor": {
    "name": "default-extractor",
    "llmProvider": "default_llm",
    "embeddingProvider": "default_embedding",
    "maxAttempts": 3
  },
  "providers": {
    "llm": {
      "default_llm": {
        "type": "openai",
        "model": "gpt-5.4-mini",
        "api": "responses",
        "apiKey": "sk-...",
        "baseUrl": "https://api.openai.com/v1"
      }
    },
    "embedding": {
      "default_embedding": {
        "type": "openai",
        "model": "text-embedding-3-small",
        "apiKey": "sk-...",
        "baseUrl": "https://api.openai.com/v1",
        "dimensions": 1536
      }
    }
  },
  "watchdog": {
    "enabled": true,
    "intervalMs": 60000,
    "compactMinFragments": 8
  }
}
```

- `storage` 缺省时，Muninn 默认使用本地 `MUNINN_HOME`
- `storage.uri` 可以切到 `s3://...` 等对象存储前缀
- `storage.storageOptions` 会透传给 Lance/object_store 初始化底层存储后端
- `extractor` 配置 session/extraction 写入和索引所需的 LLM 与 embedding provider
- `providers.llm` 支持 `mock`、`openai`、`openai-codex`
- `providers.embedding` 支持 `mock`、`openai`
- `watchdog.enabled=false` 会关闭启动检查和后台维护
- `watchdog.intervalMs` 控制 watchdog 的维护间隔
- `watchdog.compactMinFragments` 控制表维护触发的最小 fragment 数

Demo 模式：

- 可以通过顶部 `Demo` 开关启用
- 也可以通过 URL `?demo=1` 进入
- demo 数据保存在仓库内的前端 fixture 中，不会写入真实 Lance 数据集

只构建 Web：

```bash
pnpm --filter @muninn/web build
```

构建可运行的本地 runtime：

```bash
pnpm run build:runtime
```

运行：

```bash
pnpm --filter @muninn/server start
```

然后访问：

```text
http://localhost:8080/app/
```
