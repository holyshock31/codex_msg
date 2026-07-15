# Codex Message Trace Viewer

Codex Message Trace Viewer 是一个面向 Codex Desktop 的本地旁路监测与会话分析工具。它捕获 Codex Desktop 与 `codex app-server` 之间的消息流，并将原始协议事件整理成更适合排查问题的 session、turn 和 item 视图。

本项目主要用于回答这些问题：

- 一个 turn 为什么耗时很长，时间花在了哪个 item 上？
- Codex 实际发送和接收了哪些 app-server 事件？
- thinking、工具调用、命令输出、文件修改和模型回复之间是什么顺序？
- side chat、subagent 和 fork thread 如何归属到原始会话？
- 页面卡顿、跳转、连接等待或数据刷新问题发生在哪个环节？

项目不修改 Codex Desktop 安装包。当前正式支持 Windows 10/11，macOS 和 Linux 支持在路线图中。

## 主要能力

- 透明采集 Codex Desktop 与 app-server 的 stdin/stdout JSONL 消息。
- Conversation 视图按 session、turn、item 展示完整会话。
- Timeline 视图保留原始协议事件和 Full info，便于复现和调试。
- 显示 turn 持续时间以及 item 之间的时间间隔。
- 展示 user、assistant、thinking、command、MCP tool、file change、plan、diff 等内容。
- 支持 turn/item 单击快速跳转、会话筛选和 token 使用分析。
- 使用本地 Review Store 分段保存历史，viewer 重启后可以恢复最近记录。
- 采集链路按 fail-open 设计，viewer 不可用时不应阻断 Codex 的正常主链路。

## 快速开始

### 前置条件

- Windows 10/11。
- Codex Desktop。
- Git。
- Go 1.22+，首次安装时用于自动构建 wrapper。
- Node.js 20+，用于运行 viewer。

检查环境：

```powershell
git --version
go version
node --version
```

### 克隆和安装

```powershell
git clone https://github.com/holyshock31/codex_msg.git
cd codex_msg
.\codex-trace.ps1 install
```

源码仓库不提交编译产物。首次执行 `install` 时，脚本会自动构建 wrapper，并完成以下操作：

1. 将运行文件安装到 `%USERPROFILE%\Documents\CodexTrace`。
2. 设置 Codex Desktop 使用的用户级环境变量。
3. 启动本地 viewer。

安装完成后，完全退出并重新打开 Codex Desktop，然后访问：

```text
http://127.0.0.1:45123/
```

新产生的对话、thinking、工具调用、命令输出和文件修改会出现在 viewer 中。

## 日常使用

在仓库目录或安装目录中使用统一入口：

```powershell
.\codex-trace.ps1 start    # 启动 viewer
.\codex-trace.ps1 status   # 查看采集、端口和存储状态
.\codex-trace.ps1 stop     # 停止 viewer
.\codex-trace.ps1 enable   # 重新启用 Desktop trace
.\codex-trace.ps1 disable  # 禁用 trace 并回退
```

常见操作：

- 首次安装或升级：`.\codex-trace.ps1 install`
- 日常启动：`.\codex-trace.ps1 start`
- 排查连接问题：`.\codex-trace.ps1 status`
- Codex Desktop 启动异常时回退：`.\codex-trace.ps1 disable`

`start` 只启动 viewer，不会重新构建 wrapper，也不会修改环境变量。`setup` 是 `install` 的兼容别名。

## 工作方式

```text
Codex Desktop
  -> codex-trace-wrapper.exe
      -> real codex.exe app-server
      -> tcp://127.0.0.1:45124 trace ingest
          -> Node viewer / Review Store
              -> http://127.0.0.1:45123
```

wrapper 原样转发 Desktop 与 app-server 的标准输入输出，同时向本地 viewer 复制一份消息。viewer 负责事件聚合、会话展示、实时刷新和低频分段存储。

技术设计不在 README 中展开，参见：

- [项目状态与关键技术决策](docs/project-status.md)
- [整体方案记录](docs/codex-desktop-trace-viewer-plan.md)
- [Conversation 展示语义与注意事项](docs/codex-trace-viewer-notes.md)
- [页面滚动和跳转性能分析](docs/trace-viewer-scroll-performance.md)
- [本项目优化记录](本项目优化记录.md)

## 数据与安全

- Viewer 和 ingest 默认只监听 `127.0.0.1`，不对局域网公开。
- Review Store 默认保存在 `%USERPROFILE%\.codex-trace\review-store`。
- Trace 可能包含 prompt、文件内容、命令输出和工具参数，不应提交到 Git 或上传到不可信位置。
- 仓库已忽略常见的日志、PID、`events.ndjson`、`trace-*.ndjson` 和 Review Store 目录。
- 实验性 raw events 请求改写默认关闭，需要时在 `bin\config.toml` 中显式开启。
- 项目不会修改 Codex Desktop 安装文件；执行 `disable` 即可移除相关用户环境变量。

某些终端安全软件可能阻止 Codex Desktop 从临时目录或下载目录启动未签名 wrapper。默认安装位置为：

```text
C:\Users\<user>\Documents\CodexTrace\bin\codex-trace-wrapper.exe
```

## 当前限制

- 当前正式支持 Windows，安装和启停脚本使用 PowerShell。
- 源码安装依赖 Go 1.22+ 和 Node.js 20+。
- 默认端口为 `45123` 和 `45124`，端口被其他程序占用时 viewer 无法启动。
- 启动恢复只加载 Review Store 的最近窗口，更早数据尚未提供按需分页读取。
- SSH/WSL 远端 trace 仍处于持续完善阶段。
- 本项目是独立调试工具，不是 OpenAI 官方 Codex 组件。

## 文档

- [分发与使用指南](docs/distribution-user-guide.md)
- [本地开发与构建指南](docs/development-guide.md)
- [项目状态与技术决策](docs/project-status.md)
- [功能建议备忘](docs/feature-suggestions-memo.md)
- [SSH/WSL 远端 trace 方案](docs/handoff-ssh-wsl-remote-trace.md)
- [本项目优化记录](本项目优化记录.md)

## 项目结构

```text
codex-trace-wrapper/   Go wrapper 和远端 proxy trace
codex-trace-viewer/    Node 服务和浏览器界面
scripts/               安装、启停和打包脚本
tools/                 发布配置
docs/                  设计、使用和排障文档
```

## 路线图

以下内容是规划方向，不代表已经承诺具体版本或交付时间。

### 近期

- 增加按 session、thread 和 turn 的历史分页读取，降低大型存储的启动和刷新成本。
- 完善进程健康检查、丢弃事件统计和连接诊断。
- 增加更完整的端到端测试和稳定的 Windows 安装包发布流程。
- 完善远端 SSH/WSL trace 的部署、回滚和多会话支持。
- 增加可控的导出与脱敏能力，方便提交可复现的问题样本。

### macOS

- 提供 macOS 原生构建和安装脚本。
- 适配 Codex Desktop 在 macOS 上的 CLI 发现与环境注入方式。
- 支持 Apple Silicon 和 Intel 架构，并评估签名、公证和 Gatekeeper 兼容性。
- 使用符合 macOS 约定的配置、日志和本地数据目录。

### Linux

- 提供 Linux 原生 wrapper、安装脚本和 XDG 目录支持。
- 支持本地 Codex app-server 以及 SSH/容器场景的 trace 采集。
- 评估 systemd user service，用于可选的 viewer 后台启动和状态管理。
- 验证主流发行版上的 Node、浏览器和权限兼容性。

### 长期

- 统一 Windows、macOS 和 Linux 的配置格式、诊断输出和升级流程。
- 将平台相关的安装与进程管理从核心采集、聚合和展示逻辑中进一步拆分。
- 在不削弱本地隐私边界的前提下，支持更完整的会话比较、性能分析和问题复现工作流。
