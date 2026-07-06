# Handoff：SSH/WSL 远端 Codex Trace 方案

本文档记录 SSH/WSL 远端 Codex app-server 的监测思路，供后续在项目目录中继续开发。

## 背景

当前 Windows 本机方案通过 `CODEX_CLI_PATH` 让 Codex Desktop 启动本机 `codex-trace-wrapper.exe`，再由 wrapper 启动真实 `codex.exe app-server` 并复制 stdio 消息。

这个方案只覆盖本机 Desktop 直接启动本机 app-server 的链路。SSH/WSL 远端链路不同：Desktop 会通过 SSH 在远端执行 `codex app-server proxy`，该 proxy 再连接远端常驻 Unix socket app-server。

远端实测进程形态：

```text
常驻 daemon：
node .../bin/codex app-server --listen unix://
  -> native codex app-server --listen unix://

一次 Desktop 远端连接：
/bin/sh -c "...; codex app-server proxy"
  -> node .../bin/codex app-server proxy
      -> native codex app-server proxy
          -> ~/.codex/app-server-control/app-server-control.sock
          -> 常驻 daemon
```

结论：

- `app-server --listen unix://` 是远端常驻 daemon。
- `app-server proxy` 是 Desktop 每次 SSH 远端连接拉起的 stdio 转发进程。
- proxy 不解析 JSON，不调用模型，只做 `stdin/stdout <-> Unix socket` 原始字节转发。
- 远端 Unix socket 上跑的是 WebSocket HTTP Upgrade + WebSocket frames + JSON-RPC。

## 关键启动入口

远端进程命令行里能看到类似：

```sh
PATH="${CODEX_INSTALL_DIR:-$HOME/.local/bin}:$PATH"
export PATH
codex app-server proxy
```

这段完整字符串没有在 `codex-rust-v0.142.5` Rust CLI 源码中搜到，更像是 Codex Desktop/app 侧动态拼出的 SSH 远端 shell command。

本项目无需修改这段命令。用户已实测 SSH 远端非交互命令会继承 `/etc/environment`，因此可以通过远端环境变量控制 `CODEX_INSTALL_DIR`。

推荐在远端 `/etc/environment` 设置：

```text
CODEX_INSTALL_DIR=/home/<user>/.local/codex_trace/bin
```

注意：`/etc/environment` 不是 shell 脚本，建议使用绝对路径，不要写 `$HOME`。

这样 Desktop 原有命令会自然把 trace bin 放到 PATH 最前：

```sh
PATH="/home/<user>/.local/codex_trace/bin:$PATH"
```

## 推荐目录结构

远端：

```text
/home/<user>/.local/codex_trace/bin/codex                  # shim
/home/<user>/.local/codex_trace/bin/codex-proxy-trace      # 后续开发的远端 proxy trace wrapper
/home/<user>/.local/codex_trace/log/                       # 可选日志
/home/<user>/.local/bin/codex                              # 官方原始 codex，不改名、不覆盖
```

关键原则：

- 不修改官方 `~/.local/bin/codex`。
- 不把官方 `codex` 改名为 `codex.real`。
- shim 只放在 `~/.local/codex_trace/bin/codex`。
- shim 内部执行真实 `codex` 前，从 `PATH` 移除 trace bin，避免递归命中自己。

## Shim 逻辑

建议的 POSIX sh 版本：

```sh
#!/usr/bin/env sh
set -eu

TRACE_BIN="${CODEX_TRACE_BIN:-$HOME/.local/codex_trace/bin}"

# 从 PATH 中移除 trace bin，避免 exec codex 再次命中 shim。
CLEAN_PATH="$(printf '%s' "$PATH" | awk -v drop="$TRACE_BIN" '
BEGIN { RS=":"; ORS="" }
$0 != "" && $0 != drop {
  printf "%s%s", sep, $0
  sep=":"
}
')"

# 确保官方默认安装目录仍在 PATH 中。
case ":$CLEAN_PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) CLEAN_PATH="$HOME/.local/bin:$CLEAN_PATH" ;;
esac

REAL_CODEX="$(PATH="$CLEAN_PATH" command -v codex || true)"
if [ -z "$REAL_CODEX" ]; then
  echo "codex trace shim: real codex not found after removing $TRACE_BIN from PATH" >&2
  exit 127
fi

if [ "${1:-}" = "app-server" ] && [ "${2:-}" = "proxy" ]; then
  export PATH="$CLEAN_PATH"
  exec "$TRACE_BIN/codex-proxy-trace" --real-codex "$REAL_CODEX" "$@"
fi

export PATH="$CLEAN_PATH"
exec "$REAL_CODEX" "$@"
```

这个 shim 只拦截：

```sh
codex app-server proxy
```

其他命令，例如：

```sh
codex --version
codex app-server --listen unix://
codex login
```

默认直接透传到真实 `codex`。

## 为什么优先拦截 proxy

Desktop 与远端 daemon 的实时交互都经过 proxy：

```text
Codex Desktop
  -> ssh stdio
  -> remote codex app-server proxy
  -> ~/.codex/app-server-control/app-server-control.sock
  -> remote app-server --listen unix://
```

因此拦截 proxy 可以覆盖：

- WebSocket handshake。
- WebSocket frames。
- JSON-RPC request/response/notification。
- turn streaming。
- approval。
- tool/command/file events。

不建议优先 hook `app-server --listen unix://`，因为 daemon 是常驻进程，可能已经由历史连接启动；重启 daemon 会影响远端会话稳定性。先拦 proxy 更低侵入。

## 与 Windows 本机方案的区别

Windows 本机方案：

```text
Codex Desktop
  -> CODEX_CLI_PATH
  -> codex-trace-wrapper.exe
  -> real codex.exe app-server
  -> JSONL stdio
```

SSH/WSL 远端方案：

```text
Codex Desktop
  -> ssh
  -> remote codex shim
  -> remote codex-proxy-trace
  -> real codex app-server proxy
  -> WebSocket bytes over stdio/UDS
```

远端 proxy 流不是 JSONL，而是 WebSocket 原始字节流。后续 trace wrapper 需要至少做到：

- 原样转发 stdin/stdout，不能破坏 Desktop。
- 记录或转发原始 bytes。
- 后续如果要结构化展示，需要解析 WebSocket frames，再解析 text frame 内的 JSON-RPC。

## 连接 SSH 时复用 Windows viewer 的监控消息方案

核心思路：Windows 本机 wrapper 和 SSH/WSL 远端 wrapper 都生产同一种 viewer ingest 事件。viewer 继续只接收 `tcp://127.0.0.1:45124` 上的一行一个 JSON 事件，不直接理解远端 WebSocket bytes。

### 运行拓扑

```text
Windows:
Codex Desktop
  -> ssh stdio
  -> remote codex shim

codex-trace-viewer
  -> HTTP/SSE viewer: 127.0.0.1:45123
  -> trace ingest:     127.0.0.1:45124

SSH RemoteForward:
remote 127.0.0.1:45124
  -> Windows 127.0.0.1:45124

Remote:
codex shim
  -> codex-proxy-trace
      -> real codex app-server proxy
          -> ~/.codex/app-server-control/app-server-control.sock
          -> remote daemon

codex-proxy-trace
  -> tcp://127.0.0.1:45124
     # 这里的 remote localhost 通过 SSH RemoteForward 回到 Windows viewer ingest
```

这样 Windows 本机链路和远端链路都写入同一个 viewer：

```text
Windows wrapper -> Windows viewer ingest
Remote wrapper  -> SSH RemoteForward -> Windows viewer ingest
```

### SSH 转发建议

优先使用 SSH remote forward，不让 viewer 监听局域网地址：

```sshconfig
Host <codex-remote-host>
  RemoteForward 127.0.0.1:45124 127.0.0.1:45124
  ExitOnForwardFailure no
```

远端 wrapper 的 daemon URL 仍配置成：

```text
CODEX_TRACE_DAEMON_URL=tcp://127.0.0.1:45124
```

注意：远端进程看到的 `127.0.0.1:45124` 是 remote forward 入口，不是远端本地 viewer。`ExitOnForwardFailure no` 是为了保证 viewer 未启动或端口转发失败时，SSH 连接本身不要被 trace 功能阻断。wrapper 侧仍应支持本地 NDJSON fallback。

如果 Codex Desktop 使用的远端连接方式不读取用户 SSH config，则保留两个 fallback：

- 远端 wrapper 写 `~/.local/codex_trace/log/events.ndjson`，Windows 侧独立 collector 通过 SSH tail 后转发到 viewer ingest。
- WSL 在确认能访问 Windows loopback 后，直接把 `CODEX_TRACE_DAEMON_URL` 指到 Windows viewer ingest；不能确认时仍走 collector 或 SSH tunnel。

### viewer ingest 兼容事件

现有 viewer 的最小事件契约保持不变：

```json
{"seq":1,"ts_ms":1780000000000,"pid":12345,"dir":"client_to_server","raw":"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"...\"}"}
{"seq":2,"ts_ms":1780000000010,"pid":12345,"dir":"server_to_client","raw":"{\"jsonrpc\":\"2.0\",\"method\":\"...\"}"}
```

远端 wrapper 输出同样格式。`raw` 必须是完整 JSON-RPC 文本字符串，不是 WebSocket frame，也不是 base64 bytes。这样 `codex-trace-viewer/server.js` 里的 `normalizeOuter()` 可以复用现有逻辑解析 `method`、`threadId`、`turnId`、`itemId`，Conversation 视图也能继续按 session/turn/segment 聚合。

远端可附加兼容字段，当前 viewer 可以先忽略，后续 R3 再展示：

```json
{
  "schema":"codex.trace.event.v1",
  "seq":1,
  "ts_ms":1780000000000,
  "pid":12345,
  "dir":"client_to_server",
  "raw":"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"...\"}",
  "source":"remote",
  "source_id":"ssh:<host>:<pid>",
  "transport":"ssh-proxy-websocket",
  "connection_id":"<host>-<pid>-<start_ms>",
  "codec":"websocket-jsonrpc"
}
```

兼容原则：

- `seq` 只要求在单个 producer 进程内递增。跨 Windows wrapper 和 remote wrapper 可能重复，后续 viewer 如需唯一键，用 `source_id + seq`。
- `dir` 继续使用现有值：`client_to_server` 和 `server_to_client`。
- `raw` 继续保留原始 JSON-RPC 字符串，parser 失败也不丢。
- 额外字段只能 additive，不能改变现有字段含义。

### 远端方向映射

远端 proxy wrapper 的方向和 Windows 本机 wrapper 对齐：

```text
Desktop/SSH stdin -> codex-proxy-trace -> real proxy stdin
  = client_to_server

real proxy stdout -> codex-proxy-trace -> Desktop/SSH stdout
  = server_to_client
```

不要把 wrapper 自己的日志写到 stdout。stderr 也尽量只用于真实 proxy 的 stderr 透传或紧急错误；trace 调试信息写远端私有日志，例如：

```text
~/.local/codex_trace/log/proxy-trace.log
~/.local/codex_trace/log/events.ndjson
~/.local/codex_trace/log/health.json
```

### WebSocket 解码边界

`codex-proxy-trace` 的主链路职责仍是先转发、再旁路解析：

```text
read bytes -> immediately write bytes to peer
           -> enqueue copied bytes for trace parser
```

trace parser 负责：

- 识别 client -> server 的 HTTP Upgrade request。
- 识别 server -> client 的 HTTP 101 response。
- 握手完成后按方向维护独立 WebSocket frame parser。
- 处理 partial read、mask/unmask、fragmentation、continuation frame。
- 默认只把 text message 中可作为 JSON-RPC 的 payload 发给 viewer ingest。
- ping/pong/close/binary frame 只记 counters 或本地 debug log，默认不进 Conversation viewer。
- 如果检测到 `permessage-deflate`，先在 health 中标记 `compressed=true`；R2 初版可跳过压缩 text frame，后续再加 inflater。

默认不要把 HTTP handshake 和原始 WebSocket bytes 发给 viewer，否则会产生大量 `rawParseError`，影响 Timeline 可读性。需要调试协议时再打开 `CODEX_TRACE_WS_DEBUG=true`，用 `dir:"trace_status"` 或本地日志记录握手摘要。

### trace status 事件

为了让 viewer 后续能显示远端链路状态，可以定义可选 status event，但默认不参与 Conversation 聚合：

```json
{
  "seq":3,
  "ts_ms":1780000000020,
  "pid":12345,
  "dir":"trace_status",
  "raw":"{\"method\":\"trace/status\",\"params\":{\"source\":\"remote\",\"phase\":\"websocket_ready\",\"connection_id\":\"<id>\",\"client_bytes\":1024,\"server_bytes\":2048}}",
  "source":"remote",
  "transport":"ssh-proxy-websocket"
}
```

因为 `raw` 仍是 JSON 字符串，现有 Timeline 可以展示；因为没有 `threadId` / `turnId`，Conversation Store 会自然忽略。

## 推荐落地阶段

### Phase R0：shim 命中验证

目标：只证明 Codex Desktop 的 SSH 远端命令会命中 shim。

交付：

- `~/.local/codex_trace/bin/codex` shim。
- shim 写 `argv`、`PATH`、`REAL_CODEX`、时间戳到远端日志后透传。

验收：

- 连接远端会话时日志出现 `codex app-server proxy`。
- Desktop 远端会话正常。
- 其他 `codex` 命令不被 trace wrapper 接管。

### Phase R1：透明 proxy + side channel 连通

目标：实现 `codex-proxy-trace`，但先不解析 WebSocket。

交付：

- 透明启动真实 `codex app-server proxy`。
- 双向 byte 原样转发。
- 统计 client/server bytes、exit code、duration。
- 通过 SSH RemoteForward 向 Windows viewer ingest 发 `trace_status`，或写远端 `health.json`。

验收：

- viewer 未启动、RemoteForward 不存在、远端日志写失败时，Desktop 远端连接仍正常。
- viewer 启动且 RemoteForward 生效时，Timeline 能看到 remote `trace_status`。

### Phase R2：WebSocket -> JSON-RPC -> viewer event

目标：远端 wrapper 把 WebSocket text message 转换成现有 viewer event。

交付：

- WebSocket handshake detector。
- frame parser。
- JSON-RPC text payload emitter。
- 外层事件字段兼容 `seq/ts_ms/pid/dir/raw`。

验收：

- Windows viewer Timeline 同时能看到本机和远端 JSON-RPC event。
- 远端事件 `rawJson.method`、`threadId`、`turnId` 能被 `normalizeOuter()` 解析。
- Conversation 视图能展示远端 session/turn/segment。
- WebSocket 解析错误只影响 trace，不影响 stdio 转发。

### Phase R3：viewer 小幅增强 source 展示

目标：不重写 viewer，只让它保留和展示 producer 来源。

建议改动：

- `normalizeOuter()` 保留 `source`、`source_id`、`transport`、`connection_id`。
- `compactEvent()` 传递这些字段。
- Session 列表和 Timeline 增加 source badge：`local` / `remote`。
- status 区显示 active ingest clients、remote connection ids、dropped counters。

验收：

- 当前 session/turn/segment 交互不变。
- 用户能区分同一 viewer 中的 Windows 本机 session 和 SSH/WSL remote session。

### Phase R4：fallback collector

目标：处理 SSH RemoteForward 不可用的环境。

交付：

- 远端 NDJSON fallback。
- Windows 侧 `ssh tail -F ~/.local/codex_trace/log/events.ndjson` collector。
- collector 读取远端事件后原样转发到 `127.0.0.1:45124`。

验收：

- 无 RemoteForward 时仍可近实时查看远端 trace。
- collector 断开不影响 Desktop 远端会话。

## 远端 wrapper 阶段说明

远端 wrapper 的执行阶段以后以上面的“推荐落地阶段”为准。原先的 R0-R3 已合并进新方案，并补充了 SSH RemoteForward、兼容 viewer ingest 事件、source 字段展示和 fallback collector。

## 风险点

- `/etc/environment` 改动需要重新建立 SSH session 才会生效。
- 如果 Desktop 远端命令显式设置 `CODEX_INSTALL_DIR`，可能覆盖 `/etc/environment`。
- 如果真实 `codex` 不在 `~/.local/bin` 或 PATH 里，shim 需要更明确的 fallback。
- WebSocket 原始 bytes 解析比本机 JSONL stdio 更复杂。
- 远端 trace 可能包含敏感内容，日志落盘和 viewer ingest 要有默认最小化策略。

## 下一步建议

当前已实现最小可用远端 wrapper 后，建议按以下顺序部署验证：

1. Windows 侧启动 viewer，确认 `127.0.0.1:45123` 页面可打开，`127.0.0.1:45124` ingest 监听正常。
2. 构建远端二进制：

```powershell
cd <clone-directory>\codex-trace-wrapper
.\scripts\build-release.ps1
```

产物：

```text
dist\codex-proxy-trace-linux-amd64
scripts\codex-remote-shim
```

3. 复制到远端：

```text
~/.local/codex_trace/bin/codex-proxy-trace
~/.local/codex_trace/bin/codex
```

其中 `codex` 来自 `scripts/codex-remote-shim`，两者都要 `chmod +x`。

4. 远端设置 `CODEX_INSTALL_DIR`，让 Desktop SSH 命令优先命中 shim：

```text
CODEX_INSTALL_DIR=/home/<user>/.local/codex_trace/bin
```

如果写入 `/etc/environment`，需要重新建立 SSH session 才会生效。

5. 配置远端 trace 出口。

真实 SSH 远端优先用 `RemoteForward`：

```sshconfig
RemoteForward 127.0.0.1:45124 127.0.0.1:45124
```

远端 wrapper 默认连：

```text
CODEX_TRACE_DAEMON_URL=tcp://127.0.0.1:45124
```

本机 WSL2 NAT 模式下，如果不走 SSH tunnel，远端 wrapper 可直接连 Windows host gateway，例如当前机器查到的是：

```text
CODEX_TRACE_DAEMON_URL=tcp://<windows-host-gateway>:45124
```

6. 重启 Codex Desktop，连接远端会话。viewer Timeline 应出现 `source=remote`、`transport=ssh-proxy-websocket` 的 `trace/status` 和 JSON-RPC event。
