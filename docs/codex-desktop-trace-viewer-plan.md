# Codex Desktop 会话流 Trace Viewer 方案

## 目标

构建一个稳定的 Codex Desktop 旁路 trace viewer，用来捕获完整的 app-server 消息流，包括客户端请求、服务端通知、工具调用事件、审批、命令输出以及原始 JSON-RPC payload。

第一阶段不改 Codex Desktop UI。第一阶段目标是：

- Codex Desktop 正常工作，不受采集链路影响。
- 本地页面 `http://127.0.0.1:45123` 可以实时查看 trace。
- 原始数据可以持久化，用于回放和排查问题。
- 后续如果找到安全的 UI hook，再考虑嵌入 Codex Desktop 侧边栏。

## 当前事实

Codex Desktop 会启动一个本地 Rust app-server 子进程，形式类似：

```text
codex.exe app-server --analytics-default-enabled
```

Desktop 和 app-server 之间使用 stdio JSONL 通信，不是 TCP 端口：

```text
Desktop stdin/stdout <-> codex app-server stdin/stdout
```

因此，单纯把 app-server 参数改成 `--listen ws://127.0.0.1:4500` 不够，甚至大概率会让 Desktop 断连，因为 Desktop 仍然期望自己启动的是一个 stdio 子进程。更安全的拦截点是 wrapper：保留 stdio 协议，同时把数据复制到旁路通道。

WindowsApps 目录里的安装包二进制不适合作为 wrapper 后端，因为 Windows 包目录 ACL 可能会拒绝直接执行。应使用用户目录里的 CLI：

```text
C:\Users\<user>\AppData\Local\OpenAI\Codex\bin\<hash>\codex.exe
```

Codex Desktop 会读取 `CODEX_CLI_PATH`，所以可以不 patch `app.asar`，直接用环境变量把 Desktop 启动的 CLI 替换成 wrapper：

```cmd
setx CODEX_CLI_PATH "C:\path\to\codex-trace-wrapper.exe"
```

## 参考项目

### codex-web

`0xcaff/codex-web` 最接近“自定义 UI”的方向。它是面向 Codex Desktop 的浏览器前端，也支持通过 proxy 连接 app-server。它适合作为 UI 和 app-server client 的参考，但直接用 codex-web 替代 Desktop 是更大的产品决策。

适合借鉴：

- app-server UI 展示方式。
- thread / turn 的布局模式。
- 浏览器前端如何消费 app-server 事件流。

第一阶段不建议用于：

- 捕获已经运行中的 Desktop stdio 会话。

### Langfuse Codex Observability Plugin

Langfuse 插件的价值在于它不做协议拦截，而是在 turn 完成后读取 Codex session rollout transcript，再重建可观测数据。

适合借鉴：

- transcript 解析策略。
- fail-open 设计。
- 事后重建 model / tool / subagent span 的方法。

不能作为唯一方案，因为：

- 它不是实时的。
- 它不拦截 Desktop app-server stdio。

### Promptfoo Codex App Server Provider

Promptfoo 会启动并驱动自己的 app-server，通过 JSON-RPC 消费 streamed items、approval、command、file、tool metadata。

适合借鉴：

- app-server event 的规范化方式。
- trace schema 设计。
- 如何分类 app-server notification 和 streamed item。

不适合直接用于：

- attach 到已经运行中的 Codex Desktop app-server。

### codex-app-proxy / codex-proxy

这些项目证明“长驻 app-server + proxy / bridge 层”这条路线是可行的。

适合借鉴：

- 进程生命周期管理。
- app-server bridge / proxy 的工程模式。
- 本地长驻服务的设计。

不要把它们当成：

- 可以直接使用的 Desktop trace sidebar。

## 推荐架构

```text
Codex Desktop
  -> codex-trace-wrapper.exe
      -> real codex.exe app-server --analytics-default-enabled
      -> 非阻塞 trace channel
          -> trace-daemon
              -> 内存 ring buffer
              -> SQLite WAL / NDJSON archive
              -> http://127.0.0.1:45123 viewer

补偿路径：
~/.codex/sessions/**/rollout-*.jsonl
  -> transcript tailer/parser
  -> trace-daemon timeline merge
```

wrapper 必须尽量简单可靠。它不应该承担深度解析、Web 服务、UI 或同步落盘逻辑。

## 组件设计

### 1. `codex-trace-wrapper`

推荐语言：Rust 或 Go。

当前 Phase 0 已使用 Go 实现，原因是本机 Rust/MSVC 链接阶段被 PATH 中的其他 `link.exe` 干扰，出现 cargo/rustc 报成功但不产出 exe 的现象。Go 版本仍保持同样的 wrapper 边界：透明 stdio 转发、非阻塞旁路复制、stdout 不输出 wrapper 日志。

职责：

- 接收和 `codex.exe` 一样的 argv。
- 使用同样的 argv 启动真实 Codex CLI。
- 把 Desktop stdin 转发到真实 app-server stdin。
- 把真实 app-server stdout 转发到 Desktop stdout。
- 将每一行完整 JSONL 复制到非阻塞 trace channel。
- 将真实 app-server stderr 转发到 wrapper stderr 或日志文件。
- 使用真实子进程的 exit code 退出。

非目标：

- 不做 UI。
- 不做重 JSON 解析。
- 不在主转发路径上做阻塞文件写入。
- 不向 stdout 输出 wrapper 自己的日志。

关键行为：

```text
Desktop -> wrapper stdin -> real stdin
real stdout -> wrapper stdout -> Desktop
```

旁路事件格式：

```json
{"seq":1,"ts":"2026-07-02T12:00:00.000Z","pid":1234,"dir":"client_to_server","raw":"{\"id\":1,\"method\":\"...\"}"}
{"seq":2,"ts":"2026-07-02T12:00:00.010Z","pid":1234,"dir":"server_to_client","raw":"{\"method\":\"...\"}"}
```

### 2. Trace Channel

第一版推荐：本地 named pipe 或 loopback TCP，发送给 `trace-daemon`。

兜底方案：异步 NDJSON writer。

规则：

- 使用有界队列。
- 队列满时丢弃 trace event，并记录 dropped counter。
- viewer、daemon 或磁盘变慢时，绝不能阻塞 stdio 主链路。
- wrapper 分配单调递增的 sequence number。

### 3. `trace-daemon`

推荐语言：Node/TypeScript 或 Rust。

职责：

- 接收 wrapper 发来的 trace event。
- 在内存 ring buffer 中保存最近事件。
- 持久化原始事件。
- 对已知 JSON-RPC 消息做规范化解析。
- 提供本地 viewer API。
- tail rollout transcript 文件作为补偿路径。

建议存储：

- SQLite WAL 模式用于索引和查询历史。
- 原始 JSON 字符串保持不变。
- 可选 NDJSON export，方便调试。

建议 SQLite 表：

```sql
CREATE TABLE trace_events (
  seq INTEGER,
  ts TEXT NOT NULL,
  source TEXT NOT NULL,
  dir TEXT NOT NULL,
  method TEXT,
  request_id TEXT,
  thread_id TEXT,
  turn_id TEXT,
  item_id TEXT,
  raw TEXT NOT NULL,
  parse_error TEXT,
  PRIMARY KEY (source, seq)
);
```

### 4. Viewer

第一版 URL：

```text
http://127.0.0.1:45123
```

传输方式：

- SSE：适合简单的 append-only 实时流。
- WebSocket：如果需要双向控制，再使用 WebSocket。

视图：

- 实时 timeline。
- 方向过滤：client -> server / server -> client。
- method 过滤。
- raw JSON 面板。
- 当能识别标识符时，按 thread / turn 分组。
- dropped-event 指示器。
- 导出当前 session 为 NDJSON。

### 5. Transcript Compensation Parser

职责：

- 监听 `~/.codex/sessions/**/rollout-*.jsonl`。
- 解析已经完成的 turn record。
- 补齐 live trace 中缺失的字段。
- 如果实时 trace 丢事件，可以重建最终 turn summary。

这一路借鉴 Langfuse 的非侵入式模式，可以提高整体鲁棒性。

## 为什么不只写 JSONL 文件

JSONL 本身没有问题。app-server stdio 本来就是 line-oriented JSON，所以 JSONL 很适合作为持久化和调试格式。

真正的风险不是 JSONL，而是在 Desktop 依赖的主链路上同步写文件。

错误做法：

```text
read line -> write file synchronously -> forward line
```

正确做法：

```text
read line -> forward line immediately
          -> enqueue trace event for async writer
```

如果磁盘慢、杀毒软件扫描文件、viewer 变慢，Codex Desktop 仍然必须正常工作。

## 实施阶段

### Phase 0：协议探针

实现一个最小 wrapper，只负责 stdin/stdout 转发，并把 raw lines 异步记录到一个 NDJSON 文件。

交付物：

- `codex-trace-wrapper.exe`
- 包含真实 CLI 路径的配置文件。
- 一个 combined NDJSON trace 文件。

验收条件：

- `CODEX_CLI_PATH` 指向 wrapper 后，Desktop 能正常启动。
- 一个普通 Codex turn 能正常完成。
- trace 文件里同时包含 `client_to_server` 和 `server_to_client` 事件。
- wrapper 的 stdout 只包含真实 app-server stdout，不包含任何 wrapper 自己的日志。
- trace 文件写入失败时，Desktop 仍然正常工作。

### Phase 1：Trace Daemon 和实时 Viewer

把 Web 服务和存储逻辑从 wrapper 中移出，放到独立 daemon。

交付物：

- `trace-daemon`
- 本地 API：`127.0.0.1:45123`
- 实时 timeline viewer。
- wrapper 通过非阻塞 channel 向 daemon 发送 trace event。

验收条件：

- Desktop 运行时，viewer 能实时显示事件。
- viewer 或 daemon 崩溃，不影响 Desktop。
- daemon 重启后，可以接收新的 wrapper event，或至少不会阻塞 wrapper。
- wrapper 能通过本地 health 文件或 daemon status 报告 dropped trace count。
- 正常使用时，stdio 转发的额外延迟可忽略。

### Phase 2：规范化解析和分组

把 JSON-RPC 消息解析成更有用的 trace 实体。

交付物：

- request / response / notification 的 normalized schema。
- thread / turn / item / tool 分组。
- viewer 中的搜索和过滤。

验收条件：

- 当 app-server event 中存在相关信息时，可以识别 user prompt、tool-call event、command output、approval 和 final assistant message。
- 每一条 parsed row 仍然能查看 raw JSON。
- parse error 会展示出来，但不会丢弃 raw event。
- 可以从 prompt 到 final response 检视一个完整 turn。

### Phase 3：Transcript 补偿

加入 rollout transcript reader。

交付物：

- transcript tailer。
- live event 和 transcript-derived event 的 merge 逻辑。
- `"live"`、`"transcript"`、`"merged"` source label。

验收条件：

- turn 完成后，即使 live trace 漏掉部分事件，也能看到 transcript-derived 数据。
- 尽可能使用稳定 identifier 去重。
- viewer 能显示某个字段来自 live app-server traffic 还是 transcript reconstruction。

### Phase 4：Desktop 侧边展示

研究如何在 Codex Desktop 内显示 viewer。

选项：

1. 用外部浏览器打开 viewer。
2. 如果 Codex in-app browser / browser pane 支持任意 localhost URL，就在 Codex 侧边打开 viewer。
3. patch Desktop renderer，增加专用 trace side panel。

选项 1 的验收条件：

- viewer 能在普通浏览器中正常使用。

选项 2 的验收条件：

- viewer 能在 Codex thread 旁边打开，不破坏 Desktop 导航。

选项 3 的验收条件：

- patch 过程可复现、可文档化。
- patch 后重启 app 仍然可用。
- trace viewer 加载失败时，不影响正常 Codex UI。

选项 3 放在最后，因为它涉及 Desktop UI 打包，容易被更新破坏。

## 配置建议

wrapper 配置示例：

```toml
real_codex = "C:\\Users\\<user>\\AppData\\Local\\OpenAI\\Codex\\bin\\<hash>\\codex.exe"
daemon_url = "tcp://127.0.0.1:45124"
fallback_ndjson = "C:\\Users\\<user>\\.codex-trace\\events.ndjson"
queue_capacity = 10000
capture_stderr = true
```

daemon 配置示例：

```toml
listen = "127.0.0.1:45123"
ingest = "127.0.0.1:45124"
database = "C:\\Users\\<user>\\.codex-trace\\trace.sqlite3"
ring_buffer_events = 50000
enable_transcript_compensation = true
transcript_root = "C:\\Users\\<user>\\.codex\\sessions"
```

## 安全要求

当前状态：默认 HTTP 与 ingest 仅监听 loopback；随机 token、自动脱敏和完整 retention policy 尚未实现。不要把监听地址改为非 loopback，除非先补齐认证、访问控制和敏感字段处理。

trace stream 可能包含：

- prompt 和模型输出。
- 工具输入和输出。
- 文件路径。
- 环境变量值。
- 如果 app-server 输出相关信息，也可能包含认证相关 metadata。

目标要求（当前未全部实现）：

- HTTP 只绑定 `127.0.0.1`。
- viewer 访问使用随机 token。
- 不暴露到局域网。
- 支持 redaction，但 raw mode 对调试仍然必要。
- trace 存储在用户私有目录。

## 性能要求

wrapper：

- stdio 转发必须是 streaming，并正确处理 backpressure。
- trace side channel 必须有界。
- trace 失败必须 fail-open。
- 转发给 Desktop 前不得做同步落盘。

daemon：

- SQLite 写入要 batch。
- 使用 WAL 模式。
- 最近事件保存在内存 ring buffer 中。
- ingest 热路径不要解析巨大 payload；必要时异步解析。

## 风险

### Desktop CLI Path Override 变更

风险：未来 Codex Desktop 版本可能不再支持 `CODEX_CLI_PATH`。

缓解：

- 启动诊断中明确确认 wrapper 是否被调用。
- 保留 app.asar patch 作为最后 fallback，而不是默认方案。

### 协议变更

风险：app-server JSON-RPC event shape 变化。

缓解：

- 始终持久化 raw message。
- parser 使用 best-effort 策略。
- normalized schema 版本化。

### Wrapper bug 影响 Desktop

风险：wrapper bug 会中断 Codex Desktop。

缓解：

- wrapper 尽量小。
- 使用 fake app-server 做集成测试。
- tracing error 必须 fail-open。
- wrapper 日志绝不写 stdout。

### 敏感数据暴露

风险：trace viewer 暴露 prompt、文件内容或 secret。

缓解：

- localhost only。
- token gate。
- 明确 retention policy。
- 可选 redaction。

## 初始里程碑建议

先只做 Phase 0 和 Phase 1：

```text
Go/Rust wrapper + Node/TypeScript daemon + localhost viewer
```

在实时采集稳定前，不 patch Desktop UI。

第一版可用 demo 需要回答：

- Desktop 是否确实通过 wrapper 启动？
- 普通 Codex turn 是否能正常完成？
- viewer 是否能实时显示双向 app-server 消息？
- raw messages 是否可以导出和回放？
