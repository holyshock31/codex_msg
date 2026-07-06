# Codex Trace Viewer

这是本地 trace daemon + viewer。主链路不依赖 `events.ndjson`：

```text
Codex Desktop
  -> codex-trace-wrapper.exe
      -> real codex.exe app-server

codex-trace-wrapper.exe
  -> tcp://127.0.0.1:45124 trace ingest
      -> memory ring buffer
      -> http://127.0.0.1:45123 viewer
```

## 开发启动

```powershell
cd <clone-directory>\codex-trace-viewer
.\scripts\start-viewer.ps1
```

安装包使用者应从安装目录启动：

```powershell
cd "$env:USERPROFILE\Documents\CodexTrace"
.\scripts\start-viewer.ps1
```

访问：

```text
http://127.0.0.1:45123/?v=chat-redesign
```

停止/状态：

```powershell
.\scripts\status-viewer.ps1
.\scripts\stop-viewer.ps1
```

## 端口

- HTTP/SSE viewer: `127.0.0.1:45123`
- wrapper ingest: `tcp://127.0.0.1:45124`

## 数据模式

默认：

```powershell
CODEX_TRACE_PRELOAD_NDJSON=false
```

也就是只显示 daemon 启动后通过 ingest 收到的新事件。重启 daemon 后旧事件不保留。

调试旧文件时可以临时打开：

```powershell
$env:CODEX_TRACE_PRELOAD_NDJSON="true"
.\scripts\start-viewer.ps1
```

## API

- `GET /api/status`
- `GET /api/events?limit=1000`
- `GET /events` SSE live stream

## Viewer

默认是 Conversation 视图：

- 左侧按 session/thread 过滤。
- 右侧按 turn 分隔。
- 每个 turn 内聚合 user、assistant、think、command、MCP tool、file change、plan、diff 等块。
- 每个块可以点 `raw` 查看关联原始事件。

Timeline 标签保留原始事件列表和 raw JSON 调试入口。
