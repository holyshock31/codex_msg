# Codex Trace Wrapper

这是一个透明 stdio wrapper，用来拦截 Codex Desktop 和 app-server 之间的 JSONL 消息流。

它不修改 Codex Desktop 安装包。启用方式是设置用户级环境变量 `CODEX_CLI_PATH`，让 Codex Desktop 下次启动 app-server 时先启动本 wrapper。

## 构建

当前实现使用 Go。

```powershell
.\scripts\build-release.ps1
```

生成文件：

```text
dist\codex-trace-wrapper.exe
dist\codex-proxy-trace.exe
dist\codex-proxy-trace-linux-amd64
```

`codex-trace-wrapper.exe` 用于 Windows 本机 Desktop -> app-server JSONL 链路。`codex-proxy-trace-linux-amd64` 用于 SSH/WSL 远端 `codex app-server proxy` 链路，会把 WebSocket text frame 解码成同一套 viewer ingest 事件。

## 配置

示例配置：

```powershell
Copy-Item .\config.example.toml .\config.toml
```

默认配置不需要写 `real_codex`。wrapper 会从以下目录自动发现真实 Codex CLI：

```text
%LOCALAPPDATA%\OpenAI\Codex\bin
```

如果必须手动指定，可在 `config.toml` 中添加：

```toml
real_codex = "C:\\Users\\<user>\\AppData\\Local\\OpenAI\\Codex\\bin\\<build>\\codex.exe"
```

## 开发启用

不要让 `CODEX_CLI_PATH` 长期指向源码或临时构建目录。先把构建出的 exe 复制到稳定安装目录：

```text
C:\Users\<user>\Documents\CodexTrace\bin\codex-trace-wrapper.exe
```

再执行：

```powershell
$wrapperPath = Join-Path $env:USERPROFILE "Documents\CodexTrace\bin\codex-trace-wrapper.exe"
.\scripts\enable-codex-trace.ps1 `
  -WrapperPath $wrapperPath `
  -ConfigPath ".\config.toml"
```

然后重启 Codex Desktop。

## 禁用和恢复

```powershell
.\scripts\disable-codex-trace.ps1
```

然后重启 Codex Desktop。该脚本会删除用户级：

```text
CODEX_CLI_PATH
CODEX_TRACE_WRAPPER_CONFIG
```

删除后，Desktop 会回到原生 bundled CLI 路径。没有修改安装包，所以不需要还原文件。

wrapper 按 fail-open 运行：配置解析、trace 目录、viewer daemon 或本地持久化不可用时，禁用 trace 并继续透传到真实 Codex。只有真实 Codex 无法定位或启动时才返回致命错误。

查看当前环境变量状态：

```powershell
.\scripts\status-codex-trace.ps1
```

## 日志输出

默认写入：

```text
C:\Users\<user>\.codex-trace\health.json
C:\Users\<user>\.codex-trace\wrapper.log
```

主链路默认发送到：

```text
tcp://127.0.0.1:45124
```

如果 `fallback_ndjson = true`，daemon 连接或写入失败时会回退写入：

```text
C:\Users\<user>\.codex-trace\events.ndjson
```

事件格式示例：

```json
{"seq":1,"ts_ms":123,"pid":456,"dir":"client_to_server","raw":"..."}
{"seq":2,"ts_ms":124,"pid":456,"dir":"server_to_client","raw":"..."}
```

## 验证

不启动真实 Desktop 的 smoke test：

```powershell
.\tests\run-wrapper-smoke.ps1
```

这个测试使用 fake app-server 验证：

- stdin 会转发给子进程。
- 子进程 stdout 会转发给调用方。
- trace 中同时有 `client_to_server` 和 `server_to_client`。

远端 proxy trace 的 smoke test：

```powershell
.\tests\run-proxy-trace-smoke.ps1
```

这个测试使用 fake WebSocket proxy 验证：

- 双向 WebSocket frame 会被解码成 JSON-RPC。
- 输出事件仍兼容 viewer 的 `seq/ts_ms/pid/dir/raw` 格式。
- 事件带有 `source=remote`、`transport=ssh-proxy-websocket` 等来源字段。
