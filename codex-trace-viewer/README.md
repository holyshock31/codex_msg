# Codex Trace Viewer

本目录是本地 trace daemon + viewer。主链路不依赖 `events.ndjson`：

```text
Codex Desktop
  -> codex-trace-wrapper.exe
      -> real codex.exe app-server

codex-trace-wrapper.exe
  -> tcp://127.0.0.1:45124 trace ingest
      -> memory ring buffer
      -> batched review store
      -> http://127.0.0.1:45123 viewer
```

## 启动入口

日常从项目根目录启动，不要分别启动 wrapper、viewer、storage：

```powershell
.\codex-trace.ps1 start
```

安装包使用者应从安装目录启动：

```powershell
cd "$env:USERPROFILE\Documents\CodexTrace"
.\codex-trace.ps1 start
```

访问：

```text
http://127.0.0.1:45123/?v=chat-redesign
```

停止/状态：

```powershell
.\codex-trace.ps1 status
.\codex-trace.ps1 stop
```

`codex-trace-viewer\scripts\*.ps1` 是组件调试脚本。Review Store 不是独立进程，它随 viewer 的 Node 进程启动和停止。

## 端口

- HTTP/SSE viewer: `127.0.0.1:45123`
- wrapper ingest: `tcp://127.0.0.1:45124`

## 数据模式

默认：

```powershell
CODEX_TRACE_PRELOAD_NDJSON=false
```

也就是不再从旧的单文件 `events.ndjson` 预加载。实时链路使用 TCP ingest，Review 历史由 viewer 自己的低频分段存储保留。

调试旧文件时可以临时打开：

```powershell
$env:CODEX_TRACE_PRELOAD_NDJSON="true"
.\codex-trace.ps1 start
```

## Review 持久化

viewer 默认启用低频写盘的 Review Store：

```text
%USERPROFILE%\.codex-trace\review-store\segments\trace-*.ndjson
```

设计约束：

- 热路径先写内存队列，不在收到每条事件时同步写磁盘。
- 后台批量 append：默认满足 `5s`、`500` 条事件或 `512KB` 任一条件后写一次。
- 分段滚动：默认单段 `32MB` 或 `1h` 滚动。
- 启动恢复：默认只恢复最近 `64MB` / `20000` 条事件，避免全量扫描旧存储。
- 清理旧数据时删除整个旧分段，不重写历史文件，避免清理造成写放大。

常用环境变量：

```powershell
$env:CODEX_TRACE_STORAGE_ENABLED="true"
$env:CODEX_TRACE_STORAGE_DIR="D:\trace-store"
$env:CODEX_TRACE_STORAGE_FLUSH_MS="5000"
$env:CODEX_TRACE_STORAGE_BATCH_EVENTS="500"
$env:CODEX_TRACE_STORAGE_BATCH_BYTES="524288"
$env:CODEX_TRACE_STORAGE_SEGMENT_MAX_BYTES="33554432"
$env:CODEX_TRACE_STORAGE_PRELOAD_EVENTS="20000"
$env:CODEX_TRACE_STORAGE_PRELOAD_BYTES="67108864"
```

页面左侧 `Storage` 区会显示占用大小、分段数、pending 队列和最近 flush 时间，并可按“保留天数 / 目标 MB”清理旧分段。

## API

- `GET /api/status`
- `GET /api/events?limit=1000`
- `GET /api/conversations`
- `GET /api/storage?force=1`
- `POST /api/storage/cleanup`
- `POST /api/ingest`，本地 smoke/debug 用
- `GET /events` SSE live stream

## Viewer

默认是 Conversation 视图：

- 左侧按 session/thread 组织。
- 右侧按 turn 分隔。
- 每个 turn 内聚合 user、assistant、think、command、MCP tool、file change、plan、diff 等块。
- 每个块可打开 Full info 查看关联原始事件样本。

Timeline 标签保留最近原始事件列表和 raw JSON 调试入口。

## 验证

```powershell
node --check .\codex-trace-viewer\server.js
node --check .\codex-trace-viewer\public\app.js
.\codex-trace.ps1 test-storage
```
