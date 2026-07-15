# Codex Message Trace Viewer

这是一个 Codex Desktop 本地 trace viewer：不修改 Codex Desktop 安装包，通过 `CODEX_CLI_PATH` 让 Desktop 先启动 wrapper，再由 wrapper 透明转发 app-server stdio，并把消息复制到本地 viewer。

## 全新 Windows 快速开始

前置条件：

- Windows 10/11 和 Codex Desktop。
- Git。
- Go 1.22+，用于首次安装时自动构建 wrapper。
- Node.js 20+，用于运行 viewer。

```powershell
git clone https://github.com/holyshock31/codex_msg.git
cd codex_msg
.\codex-trace.ps1 install
```

源码克隆不提交编译产物。首次执行 `install` 时，如果本地没有 wrapper exe，安装脚本会自动运行 Go 构建，然后复制到 `%USERPROFILE%\Documents\CodexTrace`、设置用户级环境变量并启动 viewer。

安装结束后完全退出并重新打开 Codex Desktop。Viewer 地址：

```text
http://127.0.0.1:45123/
```

## 日常入口

日常只需要记一个脚本：

```powershell
.\codex-trace.ps1 install  # 首次安装：拷贝文件、设置 CODEX_CLI_PATH、启动 viewer
.\codex-trace.ps1 start    # 启动 viewer，storage 随 viewer 启动
.\codex-trace.ps1 status   # 查看 Desktop trace、viewer、ingest、storage 状态
.\codex-trace.ps1 stop     # 停止 viewer，storage 随 viewer 停止
```

`start` 不会拷贝 wrapper exe，也不会设置 `CODEX_CLI_PATH`。需要完整初始化时用 `install` 或等价的 `setup`。

首次启用或需要重新写入 Codex Desktop 环境变量时：

```powershell
.\codex-trace.ps1 enable
```

禁用回退：

```powershell
.\codex-trace.ps1 disable
```

`start.ps1`、`status.ps1`、`stop.ps1`、`enable-desktop-trace.ps1`、`disable-desktop-trace.ps1` 只是兼容快捷入口。`scripts/` 和各组件目录下的脚本用于调试和打包，不是日常使用入口。

## 文档入口

- 本地开发、构建、调试、打 zip 包：见 [docs/development-guide.md](docs/development-guide.md)
- 分发给同事或外部使用者：见 [docs/distribution-user-guide.md](docs/distribution-user-guide.md)
- 展示层语义和注意事项：见 [docs/codex-trace-viewer-notes.md](docs/codex-trace-viewer-notes.md)
- 项目进展和技术决策：见 [docs/project-status.md](docs/project-status.md)
- SSH/WSL 远端 trace 接续开发：见 [docs/handoff-ssh-wsl-remote-trace.md](docs/handoff-ssh-wsl-remote-trace.md)

## 当前组件

```text
codex-trace-wrapper/   # Go wrapper，接管 Desktop 启动的 app-server stdio
codex-trace-viewer/    # Node 本地 viewer，HTTP 45123，ingest 45124
scripts/               # 安装包和运行入口脚本
tools/                 # 发布包模板配置
docs/                  # 中文文档
```

某些终端安全软件会阻止 Codex Desktop 从源码目录、`AppData\Local`、`Temp` 或 `Downloads` 启动未签名 wrapper。已验证的默认安装位置是：

```text
C:\Users\<user>\Documents\CodexTrace\bin\codex-trace-wrapper.exe
```

运行时配置文件放在 wrapper 同目录：

```text
C:\Users\<user>\Documents\CodexTrace\bin\config.toml
```
