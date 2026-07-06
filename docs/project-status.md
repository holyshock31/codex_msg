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
cd <clone-directory>\codex-trace-wrapper
.\scripts\disable-codex-trace.ps1
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

### 5. 当前暂不落盘 Conversation Store

当前 Conversation Store 在内存中。viewer 重启后监测页历史会丢，但 Codex Desktop 会话本身不受影响。

后续正式化建议：

- SQLite WAL：适合查询、索引、增量更新。
- NDJSON：适合简单 append 和排查，但查询、更新、压缩较弱。

## 当前实现进展

已完成：

- Go wrapper 基本可用。
- wrapper 支持 daemon sink：`tcp://127.0.0.1:45124`。
- wrapper 支持 fallback NDJSON 开关，目前默认关闭。
- viewer Node 服务可接收 TCP ingest。
- viewer 提供 `GET /api/status`、`GET /api/events`、`GET /api/conversations`、`GET /events`。
- 前端 Conversation 视图：
  - 左侧 session 列表。
  - 左侧 session 内 turn 覆盖层导航。
  - 右侧按 turn 分隔显示 segment。
  - segment detail 已改为底部区域。
  - Full info 已改为详情按钮弹窗。
- 前端 Timeline 视图保留原始事件列表。
- Conversation Store 已实现 segment 聚合和流式 delta 合并。
- `turn/start` 生命周期事件已从 Conversation 展示层过滤。
- 左侧 turn title 已支持提取真实用户输入。
- 右侧正文和 detail 保留原始完整内容。
- 项目已迁移到：

```text
<clone-directory>
```

已验证：

- `node --check codex-trace-viewer\server.js`
- `node --check codex-trace-viewer\public\app.js`
- `go test ./...` in `codex-trace-wrapper`

## 重要注意事项

展示层语义规则集中记录在：

[codex-trace-viewer-notes.md](./codex-trace-viewer-notes.md)

当前重点：

- `turn/start` 不作为用户消息展示。
- `userMessage` item 才是 Conversation 里的用户消息。
- 左侧 turn title 可以精简。
- 右侧 conversation 正文、Segment detail、Full info 不精简。
- 受管理环境使用时，wrapper exe 默认安装到 `C:\Users\<user>\Documents\CodexTrace\bin\codex-trace-wrapper.exe`，`CODEX_CLI_PATH` 指向该路径。不要直接指向 D 盘开发目录、`AppData\Local`、`Temp` 或 `Downloads`，这些路径可能被终端安全软件拦截并导致 Codex Desktop 报 `spawn EPERM`。

## 当前限制

- viewer 重启后内存历史丢失。
- 当前旧 viewer 进程如果仍在运行，会占用 `45123/45124`，新目录 viewer 启动前需要先停止旧 viewer。
- 如果 Codex 内部工具环境也启动 `codex app-server --listen stdio://`，可能出现额外 wrapper 进程；这不是 Desktop 主链路。
- `docs/codex-desktop-trace-viewer-plan.md` 是早期方案记录，部分环境读取时可能显示乱码；后续以本文件、根 README 和 notes 文件为准。

## 建议下一步

1. 将 `Conversation Store` 落盘到 SQLite 或 NDJSON。
2. 在 wrapper 里增加可选过滤，忽略 `--listen stdio://` 这类工具链路。
3. 在 viewer 顶部显示数据来源与丢弃状态，例如 raw ring 已丢弃多少事件。
4. 给 `/api/conversations` 增加按 session/turn 拉取的接口，避免全量返回过大。
5. 补充一组端到端 smoke：启动 fake app-server、发送 turn/user/tool/delta、断言 conversation 聚合结果。
