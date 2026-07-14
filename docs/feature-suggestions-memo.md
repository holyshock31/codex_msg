# Codex Trace Viewer 功能建议备忘

本文档只是功能建议备忘，用于沉淀后续可能有价值的方向。它不是 roadmap，不代表已经决定要做，也不代表实现顺序、优先级承诺或交付计划。

## Conversation Snapshot

建议增加低频会话快照，用来解决 viewer 重启后需要扫描大量 `.ndjson` segment 才能恢复会话树的问题。

可以在 Review Store 下维护一个聚合快照，例如：

```text
review-store
  ├── segments/*.ndjson
  └── snapshots/conversations-latest.json
```

启动时先读取 snapshot，再补最近的 segment。这样可以减少启动恢复成本，也能避免单纯依赖“预加载最近 N 条事件”导致旧会话暂时看不到。

需要注意：snapshot 不能替代原始 trace segment。segment 仍然是诊断事实源，snapshot 只是加速 UI 恢复。

## 存储瘦身和压缩

目前已经避免后续落盘 streaming delta，但历史 segment 仍可能比较大。可以继续考虑：

- 将旧 segment 压缩成 `.ndjson.gz`
- 对历史大 raw response 做截断或迁移
- 给单条超大事件设置落盘上限
- 清理旧 delta-only segment
- 支持按 session 或 thread 清理，而不是只能按天数或目标容量清理

这个方向的价值是控制长期磁盘占用，尤其适合长时间挂着 Desktop trace 的场景。

## Storage Breakdown 页面

建议在 Review 页面增加存储分析视图，显示哪些事件类型、哪些 thread、哪些 segment 占用了最多空间。

示例：

```text
Storage breakdown
  command output              124 MB
  raw response                 85 MB
  assistant delta              40 MB
  file patch updated           33 MB
```

这个功能可以帮助判断存储为什么变大，也能为清理策略提供依据。

## 全局搜索

建议增加跨会话搜索，支持搜索：

- 用户输入
- assistant 回复
- reasoning summary
- command
- command output
- MCP tool name 和参数
- 文件路径
- diff 内容
- error、exit code 非 0

搜索结果应该能直接跳到对应的 `session -> thread -> turn -> block`。这会明显提升 review 效率。

## 复盘视图过滤

建议在右侧消息区增加视图模式，而不仅仅依赖顶部 method/text 过滤。

可选模式：

```text
All
User + Assistant
Commands
Tools
Files / Diffs
Errors
Reasoning
```

这个功能适合快速复盘“这次 Codex 到底执行了什么命令、改了哪些文件、哪里出错”。

## 命令面板

建议为每个会话增加命令汇总面板，按 turn 汇总所有 command execution。

字段可以包括：

- command
- cwd
- status
- exit code
- duration
- output size
- 所属 turn 编号

这个功能对排查 Codex 行为很直接，尤其是当右侧消息很多时，比逐个 block 找命令更高效。

## Diff 专用视图

建议为文件变更提供专门视图，而不是只在普通 block 中显示 diff 文本。

可以支持：

- 文件列表
- 每个文件新增/删除统计
- 按文件展开 diff
- 点击跳回产生该 diff 的 turn
- 区分 patchUpdated 和最终 fileChange

这个功能适合把 trace viewer 从“消息查看器”提升成“变更复盘工具”。

## 会话归类调试信息

当前已经有正常会话、临时会话、side chat、subagent 等归类。后续可以增加“归类依据”展示。

例如在 thread 详情或 hover 中显示：

```text
relation: subagent
evidence: parentThreadId

relation: side chat
evidence: forkedFromId

relation: temporary
evidence: ephemeral/threadSource/system or metadata-gap fallback
```

这个功能主要用于调试归类错误，避免 viewer 的自动归类看起来像黑盒。

## 隐藏和筛选特殊会话

建议增加几个轻量开关：

- 隐藏空会话
- 隐藏临时会话
- 只看主会话
- 只看 subagent
- 只看 side chat
- 只看 system helper

这类功能不改变底层数据，只改善左侧树的可读性。

## Raw/Event 调试模式

建议保留普通 review 视图的简洁性，同时为调试协议问题提供更强的 raw event 模式。

可以显示：

- seq
- request id
- direction
- method
- threadId / turnId / itemId
- compact raw JSON
- request/response 对应关系
- thread metadata 变化记录

这个功能适合排查 wrapper、app-server 协议、experimental raw event 相关问题。

## 会话导出

建议支持导出单个会话或 thread。

格式可以包括：

- Markdown
- JSON
- 仅用户和 assistant 对话
- 带命令输出
- 带 diff
- 带 raw event sample

这个功能适合做问题复盘、外部分享或归档。

## 事件采样策略可视化

当前 block 内 raw event 采用 head/tail sample。建议在 UI 中明确显示：

- sampled events 数量
- omitted event count
- head/tail 配置
- 是否内容被截断

这样用户能知道当前看到的是完整内容、聚合内容，还是采样后的调试信息。

## 可考虑但不急的方向

这些方向有价值，但复杂度或维护成本更高，适合后面再评估：

- SQLite 索引，只存索引不替代 segment
- full-text search index
- session/tag 手动标注
- 多 viewer 实例合并
- 远端 trace 统一接入
- 对 Codex Desktop sidebar 分类进行更接近原生 UI 的复刻

以上内容只是建议备忘。真正实施前仍需要结合当前问题、实现成本、数据安全和磁盘写入频率单独评估。
