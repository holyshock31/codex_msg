# 分发与使用指南

本文档面向安装和使用者。目标是拿到 `CodexTrace.zip` 后，用固定目录安装并启动本地 Codex Trace Viewer。

## 推荐方式

推荐使用 zip 包分发：

```text
CodexTrace.zip
```

解压后运行 `install.ps1`。安装脚本会把运行文件复制到：

```text
C:\Users\<user>\Documents\CodexTrace
```

其中 wrapper 可执行文件必须位于：

```text
C:\Users\<user>\Documents\CodexTrace\bin\codex-trace-wrapper.exe
```

运行时配置文件与 wrapper 放在同一目录：

```text
C:\Users\<user>\Documents\CodexTrace\bin\config.toml
```

这是项目的稳定默认安装路径。受管理设备仍可能要求代码签名、管理员审批或安全软件放行；不要把该路径理解为绕过组织策略的方式。

## 前置条件

- Windows。
- 已安装 Codex Desktop。
- 已安装 Node.js 20+，并且 `node` 在 PowerShell 中可用。

检查 Node：

```powershell
node --version
```

如果后续 release zip 内置 portable Node，则可以取消 Node 前置条件。

## 首次安装

1. 解压 `CodexTrace.zip` 到任意临时目录，例如桌面。
2. 在解压目录打开 PowerShell。
3. 执行：

```powershell
.\codex-trace.ps1 install
```

脚本会做三件事：

- 复制文件到 `$env:USERPROFILE\Documents\CodexTrace`。
- 写入 Codex Desktop 后续启动需要的用户级环境变量。
- 启动 viewer。

安装完成后，完全退出并重新打开 Codex Desktop。

`install.ps1` 仍保留为兼容入口，但推荐统一使用 `codex-trace.ps1 install`。

## 打开 Viewer

安装脚本默认会启动 viewer。也可以手动启动：

```powershell
cd "$env:USERPROFILE\Documents\CodexTrace"
.\codex-trace.ps1 start
```

打开：

```text
http://127.0.0.1:45123/?v=chat-redesign
```

正常情况下，Codex Desktop 里的新对话、thinking、工具调用、命令输出等会出现在 viewer 中。

## 日常使用

首次安装成功后，日常一般只需要：

```powershell
cd "$env:USERPROFILE\Documents\CodexTrace"
.\codex-trace.ps1 start
```

然后打开 Codex Desktop 和 viewer 页面。

如果 viewer 已经在运行，启动脚本会提示已经运行，并显示当前 URL、PID 和 storage 状态。

Review storage 不需要单独启动，它随 viewer 启动和停止。`start` 不会拷贝 wrapper exe，也不会设置 `CODEX_CLI_PATH`；需要完整初始化时用 `install` 或 `setup`。`start.ps1`、`status.ps1`、`stop.ps1` 等旧入口仍保留为兼容快捷方式，但推荐只使用 `codex-trace.ps1`。

如需捕获 `rawResponseItem/completed`，可编辑安装目录的 `bin\config.toml`：

```toml
[rewrite]
enable_experimental_raw_events = true
```

这是协议改写开关，会让 wrapper 给 Desktop 发往 app-server 的请求注入 experimental raw events 参数；排查完成后可改回 `false`。

## 查看状态

```powershell
cd "$env:USERPROFILE\Documents\CodexTrace"
.\codex-trace.ps1 status
```

重点确认：

- `CODEX_CLI_PATH` 指向 `Documents\CodexTrace\bin\codex-trace-wrapper.exe`。
- `CODEX_TRACE_WRAPPER_CONFIG` 指向 `Documents\CodexTrace\bin\config.toml`。
- viewer 端口 `127.0.0.1:45123` 正在监听。
- ingest 端口 `127.0.0.1:45124` 正在监听。

## 停止 Viewer

```powershell
cd "$env:USERPROFILE\Documents\CodexTrace"
.\codex-trace.ps1 stop
```

## 重新启用 Desktop Trace

如果升级后或排障后需要重新写入环境变量：

```powershell
cd "$env:USERPROFILE\Documents\CodexTrace"
.\codex-trace.ps1 enable
```

执行后需要完全退出并重新打开 Codex Desktop。

## 禁用和回退

如果 Codex Desktop 启动异常，先禁用 trace：

```powershell
cd "$env:USERPROFILE\Documents\CodexTrace"
.\codex-trace.ps1 disable
```

然后完全退出并重新打开 Codex Desktop。

禁用脚本会删除用户级环境变量：

```text
CODEX_CLI_PATH
CODEX_TRACE_WRAPPER_CONFIG
```

这个工具不修改 Codex Desktop 安装包，因此不需要还原安装文件。

## 升级

1. 退出 Codex Desktop。
2. 停止 viewer。
3. 解压新版 `CodexTrace.zip`。
4. 在新版解压目录执行：

```powershell
.\codex-trace.ps1 install
```

5. 重新打开 Codex Desktop。

## 常见问题

### Codex Desktop 报 `spawn EPERM`

通常是 Windows 或组织安全策略阻止了外部 wrapper 启动。

检查：

```powershell
[Environment]::GetEnvironmentVariable("CODEX_CLI_PATH", "User")
```

默认应是：

```text
C:\Users\<user>\Documents\CodexTrace\bin\codex-trace-wrapper.exe
```

如果指向源码、临时构建或下载目录，请重新执行安装目录中的：

```powershell
.\codex-trace.ps1 enable
```

### Viewer 页面没有数据

检查：

- Codex Desktop 是否在启用 trace 后重启过。
- `CODEX_CLI_PATH` 是否正确。
- viewer 是否已启动。
- 当前 Codex Desktop 是否产生了新事件。

viewer 显示启动后通过 ingest 收到的新事件，并从 Review Store 恢复最近的已落盘窗口。尚未刷盘的事件以及超出恢复窗口的旧数据不会自动恢复。

### 端口被占用

默认端口：

```text
HTTP viewer: 127.0.0.1:45123
trace ingest: 127.0.0.1:45124
```

先执行：

```powershell
.\codex-trace.ps1 stop
```

如果仍被占用，执行：

```powershell
.\codex-trace.ps1 status
```

查看占用进程后再处理。
