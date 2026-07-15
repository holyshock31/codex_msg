# Codex Message Trace Viewer 项目状态

## 目标需求

在不修改 Codex Desktop 安装包的前提下，为 Codex Desktop 增加一个本地旁路监测页，用于查看完整 app-server 会话流。

核心目标：

- 捕获 Desktop 与 `codex app-server` 之间的 JSONL 消息流。
- 展示 session、turn、segment 三级结构。
- 展示 user、assistant、think、command、MCP tool、file change、plan、diff 等内容。
- 保留原始事件 Timeline 和 Full info，用于排查协议细节。
- 尽量不影响 Desktop 正常使用；采集链路失败时应 fail-open。

当前页面入口：

```text
http://127.0.0.1:45123/?v=chat-redesign
```

## 当前架构

```text
进程结构如下（Codex还有其他子进程，此处不展示）：
Codex.exe                         # Codex Desktop 主进程
├─ codex-trace-wrapper.exe         # 我们通过 CODEX_CLI_PATH 接管的 CLI 入口，连接codex-trace-viewer的45124
│  ├─ codex.exe                    # 真实 Codex app-server

node.exe                           # codex-trace-viewer，独立启动
└─ server.js
   ├─ HTTP 监听 127.0.0.1:45123    # viewer 页面
   └─ TCP 监听 127.0.0.1:45124     # trace ingest
```

组件职责：

- `codex-trace-wrapper`：Go wrapper，原样转发 app-server stdin/stdout，同时把消息复制到 viewer ingest。
- `codex-trace-viewer`：Node 本地服务，接收 trace，提供 HTTP/SSE/API 和静态页面。
- `public/app.js`：前端 UI，渲染 Conversation 和 Timeline。

使用方式见根目录 [README.md](../README.md)。

## 关键技术决策

### 1. 使用 `CODEX_CLI_PATH` 接管 Desktop 启动，不 patch 安装包

原因：

- WindowsApps 安装目录受 ACL 保护，不适合作为改包入口。
- patch `app.asar` 或官方二进制升级风险高。
- `CODEX_CLI_PATH` 可以让 Desktop 启动自定义 wrapper，回退方式简单。

回退：

```powershell
.\codex-trace.ps1 disable
```

### 2. wrapper 保持 stdio 原样转发

Desktop 期望启动的是 stdio app-server 子进程，因此 wrapper 必须透明转发 stdin/stdout，不能把主链路改成 TCP/WebSocket。

旁路 trace 通过 daemon URL 发送：

```text
tcp://127.0.0.1:45124
```

### 3. viewer 独立运行，不由 wrapper 自动启动

viewer 是独立 Node 进程：

```text
node.exe server.js
```

它负责：

- `45123`：Web viewer。
- `45124`：trace ingest。

wrapper 只负责连接 viewer，不负责启动 viewer。正式使用时建议先启动 viewer，再启动 Desktop。

### 4. Raw Event 与 Conversation Store 分层

Raw Event Ring：

- 存最近原始事件。
- 用于 Timeline 和 debug。
- 可以按容量丢旧事件。

Conversation Store：

- 按 `session -> turn -> segment` 聚合。
- 流式 delta 聚合成 segment 内容。
- 中间流式 event 只保留 head/tail raw sample 和计数。

这样长流式输出不会用大量 delta event 挤掉对话展示内容。

### 5. Review Store 低频分段持久化

viewer 默认启用独立 Review Store，用于解决内存 ring buffer 滚动后旧 side chat / subagent 记录无法回看的问题。

设计选择：

- 不复用 Codex 自身 rollout/state DB，也不写 SQLite。Codex 的 rollout 是会话事实源，viewer 需要保留 app-server 原始协议流、方向、请求 id、parse error、transport 等诊断字段。
- 热路径只写内存队列，不在每条事件到达时同步写磁盘。
- 后台批量 append 到 `.ndjson` 分段：默认 `5s`、`500` 条事件或 `512KB` 任一条件触发一次写入。
- 分段默认 `32MB` 或 `1h` 滚动。
- 启动时默认只恢复最近 `64MB` / `20000` 条事件，避免全量扫描历史。
- Review 页左侧 `Storage` 区显示占用、分段数、pending 队列和最近 flush 时间。
- 清理旧存储时删除整个旧分段，不重写历史文件，避免清理造成写放大。

## 当前实现进展

已完成：

- Go wrapper 基本可用。
- wrapper 支持 daemon sink：`tcp://127.0.0.1:45124`。
- wrapper 支持 fallback NDJSON 开关，目前默认关闭。
- viewer Node 服务可接收 TCP ingest。
- viewer 提供 `GET /api/status`、`GET /api/events`、`GET /api/conversations`、`GET /api/storage`、`POST /api/storage/cleanup`、`GET /events`。
- 前端 Conversation 视图：
  - 左侧 session 列表。
  - 左侧 session 内 turn 覆盖层导航。
  - 右侧按 turn 分隔显示 segment。
  - segment detail 已改为底部区域。
  - Full info 已改为详情按钮弹窗。
- 前端 Timeline 视图保留原始事件列表。
- Conversation Store 已实现 segment 聚合和流式 delta 合并。
- Review Store 已实现低频分段持久化、启动恢复和旧分段清理。
- Review 页已显示存储占用，并支持按保留天数/目标大小清理旧存储。
- 日常启停已收敛到根目录 `codex-trace.ps1`；`install/setup` 负责拷贝文件、设置 `CODEX_CLI_PATH` 并启动 viewer，`start` 只负责启动 viewer；Review Store 随 viewer 启停，不需要单独启动 storage。
- wrapper 已支持 `[rewrite].enable_experimental_raw_events`，开启后会注入 `initialize.capabilities.experimentalApi=true` 和 `thread/start.experimentalRawEvents=true`，用于捕获 `rawResponseItem/completed`。
- `turn/start` 生命周期事件已从 Conversation 展示层过滤。
- 左侧 turn title 已支持提取真实用户输入。
- 右侧正文和 detail 保留原始完整内容。
- 项目源码目录：

```text
<clone-directory>
```

已验证：

- `node --check codex-trace-viewer\server.js`
- `node --check codex-trace-viewer\public\app.js`
- `codex-trace-viewer\scripts\test-storage.ps1`
- `go test ./...` in `codex-trace-wrapper`

## 重要注意事项

展示层语义规则集中记录在：

[codex-trace-viewer-notes.md](./codex-trace-viewer-notes.md)

当前重点：

- `turn/start` 不作为用户消息展示。
- `userMessage` item 才是 Conversation 里的用户消息。
- 左侧 turn title 可以精简。
- 右侧 conversation 正文、Segment detail、Full info 不精简。
- 受管理环境使用时，wrapper exe 默认安装到 `C:\Users\<user>\Documents\CodexTrace\bin\codex-trace-wrapper.exe`，运行时配置安装到同目录 `C:\Users\<user>\Documents\CodexTrace\bin\config.toml`。`CODEX_CLI_PATH` 和 `CODEX_TRACE_WRAPPER_CONFIG` 分别指向这两个路径。不要直接指向 D 盘开发目录、`AppData\Local`、`Temp` 或 `Downloads`，这些路径可能被终端安全软件拦截并导致 Codex Desktop 报 `spawn EPERM`。

## 当前限制

- viewer 重启后会从 Review Store 恢复最近窗口；超过 `CODEX_TRACE_STORAGE_PRELOAD_BYTES` / `CODEX_TRACE_STORAGE_PRELOAD_EVENTS` 的旧数据需要后续分页读取能力。
- 当前旧 viewer 进程如果仍在运行，会占用 `45123/45124`，新目录 viewer 启动前需要先停止旧 viewer。
- 如果 Codex 内部工具环境也启动 `codex app-server --listen stdio://`，可能出现额外 wrapper 进程；这不是 Desktop 主链路。
- `docs/codex-desktop-trace-viewer-plan.md` 是早期方案记录，部分环境读取时可能显示乱码；后续以本文件、根 README 和 notes 文件为准。

## 建议下一步

1. 给 Review Store 增加按 session/thread/turn 的分页读取接口，避免启动恢复窗口过大。
2. 在 wrapper 里增加可选过滤，忽略 `--listen stdio://` 这类工具链路。
3. 在 viewer 顶部显示数据来源与丢弃状态，例如 raw ring 已丢弃多少事件。
4. 给 `/api/conversations` 增加按 session/turn 拉取的接口，避免全量返回过大。
5. 补充更完整的端到端 smoke：启动 fake app-server、发送 turn/user/tool/delta、断言 conversation 聚合结果。
