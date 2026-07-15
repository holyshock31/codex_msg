# Codex Trace Viewer 注意事项

## Conversation 展示层不要把 `turn/start` 当作用户消息

Codex app-server 流里可能同时出现：

- `turn/start`：turn 生命周期事件，里面可能携带一份用户输入。
- `item/started` / `item/completed` 且 `item.type === "userMessage"`：真正的用户消息 item。

这两类事件内容可能看起来完全一样，但语义不同。`turn/start` 不是对话内容里的用户消息，而且它不一定带正式的 `turnId`。如果把它也聚合为 user segment，会出现同一条用户输入展示两次，甚至被拆成两个 turn 的问题。

实现约定：

- Conversation Store 不把 `turn/start` 聚合成 block。
- Timeline 和 Full info 仍保留 `turn/start`，用于调试原始协议流。
- 如果历史内存中已经存在 `meta === "turn/start"` 的 block，前端渲染层需要过滤掉。
- turn 数量、block 数量、左侧 turn 导航都应基于过滤后的可展示 block 计算。

## Turn title 可以精简，但正文区域不要精简

Codex Desktop 会在用户输入前注入环境上下文，例如：

- `# In app browser: ...`
- `# Files mentioned by the user: ...`
- `## My request for Codex: ...`

这些前缀对调试和复现很有价值，但不适合作为左侧 turn title 的开头，否则导航里全是环境信息，看不到用户真正的问题。

实现约定：

- 左侧 turn title 使用精简后的用户输入：优先提取 `## My request for Codex:` 之后的内容。
- 如果没有该标记，可以再尝试跳过 `# In app browser:`、`# Files mentioned by the user:` 等环境块。
- 右侧 conversation 内容区域不要精简，user segment 应保留完整原始内容。
- Segment detail 的 Content 和 Full info 也应保留原始内容，便于排查客户端实际发送了什么。

简化原则：

```text
左侧导航 = 给人扫读，显示真实问题
右侧正文 = 给人检查，保留原始消息
Timeline / Full info = 给人调试，保留协议事件
```

## 受管理环境安装路径与终端安全软件

部分企业电脑安装的终端安全软件可能阻止 Codex Desktop 从用户可写目录启动外部未签名 exe，Codex Desktop 日志里通常表现为 `spawn EPERM`。

已验证：

- `C:\Users\<user>\Documents\CodexTrace\bin\codex-trace-wrapper.exe` 可作为受管理环境默认安装路径。
- `<clone-directory>\codex-trace-wrapper\dist\codex-trace-wrapper.exe` 不适合作为 `CODEX_CLI_PATH`。
- `C:\Users\<user>\AppData\Local\CodexTrace\bin\codex-trace-wrapper.exe` 不适合作为 `CODEX_CLI_PATH`。

使用约定：

- 源码和 viewer 可以继续放在任意克隆目录。
- `CODEX_CLI_PATH` 必须指向安装目录下的 wrapper exe：

```text
C:\Users\<user>\Documents\CodexTrace\bin\codex-trace-wrapper.exe
```

- `CODEX_TRACE_WRAPPER_CONFIG` 应指向 wrapper exe 同目录的运行时配置：

```text
C:\Users\<user>\Documents\CodexTrace\bin\config.toml
```

- 后续如果受管理环境分发或安装，应默认复制 wrapper 和 `config.toml` 到 `C:\Users\<user>\Documents\CodexTrace\bin\`，不要直接从 D 盘开发目录、`AppData\Local`、`Temp`、`Downloads` 等目录启动。
