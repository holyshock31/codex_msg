# 本地开发与构建指南

本文档面向项目开发者，用于在源码目录中修改、构建、调试和生成 release zip。给同事安装或使用时不要参考本文档，使用 [distribution-user-guide.md](./distribution-user-guide.md)。

## 开发目录

下文假设 PowerShell 当前位于克隆后的仓库根目录：

```powershell
$RepoRoot = (Resolve-Path .).Path
```

主要模块：

```text
codex-trace-wrapper/   # Go wrapper
codex-trace-viewer/    # Node viewer
scripts/               # release 打包脚本和安装包入口脚本
tools/                 # release 配置模板
docs/                  # 中文文档
```

不建议提交或放进安装包的运行产物：

```text
codex-trace-viewer/logs/
codex-trace-wrapper/dist/codex-trace-wrapper-*.exe
codex-trace-wrapper/dist/process-probe.exe
dist/
```

## 启动开发版 Viewer

```powershell
.\codex-trace.ps1 start
```

访问：

```text
http://127.0.0.1:45123/?v=chat-redesign
```

状态和停止：

```powershell
.\codex-trace.ps1 status
.\codex-trace.ps1 stop
```

`codex-trace-viewer\scripts\start-viewer.ps1`、`stop-viewer.ps1`、`status-viewer.ps1` 保留给组件级调试。Review storage 是 viewer 内部能力，不需要单独启动。

`start` 不会拷贝 wrapper exe，也不会设置 `CODEX_CLI_PATH`。从源码目录执行完整初始化时直接运行：

```powershell
.\codex-trace.ps1 install
```

如果 wrapper 尚未构建，`install` 会自动调用 Go 构建。

如果需要捕获 `rawResponseItem/completed` 这类原始 Responses item 通知，可以在安装后的 `bin\config.toml` 或开发配置中打开：

```toml
[rewrite]
enable_experimental_raw_events = true
```

该开关会改写 Desktop -> app-server 请求：给 `initialize` 注入 `capabilities.experimentalApi=true`，给 `thread/start` 注入 `experimentalRawEvents=true`。这不是纯旁路监控，排查完成后可改回 `false`。

## 构建 Wrapper

```powershell
cd .\codex-trace-wrapper
.\scripts\build-release.ps1
cd ..
```

输出：

```powershell
Join-Path $RepoRoot "codex-trace-wrapper\dist\codex-trace-wrapper.exe"
```

验证：

```powershell
go test ./...
```

Viewer 语法检查：

```powershell
node --check .\codex-trace-viewer\server.js
node --check .\codex-trace-viewer\public\app.js
```

`codex-trace-wrapper\tests\run-wrapper-smoke.ps1` 是 wrapper 端到端 smoke test，但当前在本机 PowerShell 进程重定向场景下仍有卡住风险，暂不作为 release 必跑项。后续应把该测试改成独立 Go/Node 测试驱动，避免 PowerShell 管道和子进程重定向差异影响结果。

## 开发机启用 Trace

受管理环境环境不要把 `CODEX_CLI_PATH` 直接指向 D 盘源码目录。开发构建完成后，推荐直接走总入口安装：

```powershell
.\codex-trace.ps1 install
```

安装会把 wrapper 和运行时配置复制到 `$env:USERPROFILE\Documents\CodexTrace\bin\`，并让 `CODEX_CLI_PATH` 指向 `bin\codex-trace-wrapper.exe`、`CODEX_TRACE_WRAPPER_CONFIG` 指向 `bin\config.toml`。

启用后完全退出并重新打开 Codex Desktop。

查看当前环境变量：

```powershell
.\scripts\status-codex-trace.ps1
```

禁用回退：

```powershell
.\scripts\disable-codex-trace.ps1
```

然后重启 Codex Desktop。

## 生成对外 Zip 包

对外不要直接压缩源码目录。使用 release 打包脚本：

```powershell
.\scripts\build-release-package.ps1
```

输出：

```powershell
Join-Path $RepoRoot "dist\CodexTrace.zip"
```

release zip 的目标结构：

```text
CodexTrace.zip
  install.ps1
  codex-trace.ps1
  start.ps1
  stop.ps1
  status.ps1
  enable-desktop-trace.ps1
  disable-desktop-trace.ps1
  README.md
  bin/
    codex-trace-wrapper.exe
    config.toml
  scripts/
    enable-desktop-trace.ps1
    disable-desktop-trace.ps1
    start-viewer.ps1
    stop-viewer.ps1
    status.ps1
  codex-trace-wrapper/
    config.toml
  codex-trace-viewer/
    server.js
    package.json
    public/
    scripts/
  docs/
    distribution-user-guide.md
```

其中运行时使用的 `bin/config.toml` 来自 [tools/release-config.toml](../tools/release-config.toml)，不会包含本机用户名、真实 Codex build hash 或 D 盘路径。`codex-trace-wrapper/config.toml` 仍随包保留，主要用于排障和兼容旧路径。

## 本地验证 Release 包

先生成 zip，然后解压到临时目录，执行：

```powershell
.\codex-trace.ps1 install -NoEnable -NoStartViewer
```

这一步只验证复制结构，不改 Codex Desktop 环境变量、不启动 viewer。

要完整验证安装包流程：

```powershell
.\codex-trace.ps1 install
```

完整流程会做三件事：

- 复制安装包到 `$env:USERPROFILE\Documents\CodexTrace`。
- 写入用户级 `CODEX_CLI_PATH` 和 `CODEX_TRACE_WRAPPER_CONFIG`。
- 启动 viewer。

首次启用或升级后，需要重启 Codex Desktop。

安装后根目录会保留快捷脚本：

```powershell
.\codex-trace.ps1 install
.\codex-trace.ps1 start
.\codex-trace.ps1 status
.\codex-trace.ps1 stop
.\codex-trace.ps1 enable
.\codex-trace.ps1 disable
```

`start.ps1`、`stop.ps1`、`status.ps1`、`enable-desktop-trace.ps1`、`disable-desktop-trace.ps1` 也会保留，但只是兼容快捷方式。

## 公司安全软件注意

组织安全策略可能阻止 Codex Desktop 从以下位置启动 wrapper：

```text
<clone-directory>\...
C:\Users\<user>\AppData\Local\...
Temp
Downloads
```

表现通常是 Codex Desktop 日志里的 `spawn EPERM`。因此源码可以放 D 盘，但 `CODEX_CLI_PATH` 指向的 exe 应复制到：

```text
C:\Users\<user>\Documents\CodexTrace\bin\codex-trace-wrapper.exe
```

`CODEX_TRACE_WRAPPER_CONFIG` 应指向安装目录内与 wrapper exe 同目录的 `bin\config.toml`。

## 前置依赖

开发机需要：

- Go，用于构建 wrapper。
- Node.js 20+，用于运行 viewer。
- Windows PowerShell。

当前 release zip 仍依赖目标机器已有 Node.js 20+。如果要做到完全免依赖，后续需要在 zip 中附带 portable Node，或把 viewer 打包成独立可执行文件。

## SSH/WSL 远端链路

本机 Windows `CODEX_CLI_PATH` wrapper 不覆盖 SSH/WSL 远端 app-server proxy。远端方案和接续开发事项见 [handoff-ssh-wsl-remote-trace.md](./handoff-ssh-wsl-remote-trace.md)。
