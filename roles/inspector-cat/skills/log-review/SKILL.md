---
name: log-review
description: 把 XiaoBa Trace 中有证据的问题整理为可执行的 Finding + Case
version: 3.0.0
author: InspectorCat Team
user_invocable: true
---

# Log Review

分析 XiaoBa `.jsonl` Trace 或运行日志，输出最小的 `Finding + Case` 对。

## 工作流

1. 读取调用方指定的 Trace；大文件先用 `analyze_log` 的 `quick` 模式。
2. 找到 ToolResult、artifact、delivery、权限、安全或用户目标上的实际问题。
3. 只保留证据充分且能写成可执行 Case 的问题。
4. 为每个问题同时生成 Finding、Case、Oracle 和 source trace refs。
5. 没有合格问题时返回空 `finding_cases`。

## 硬规则

- 不修复、不评分、不宣布通过或失败。
- 不输出单独 Finding；正式 Finding 必须带可 Replay Case。
- Case 不包含预写模型响应。
- 不决定交给 EngineerCat 还是 EvolutionCat。
- 不分析本轮 Case Replay 产生的新 Trace，避免递归。
- 正式调用严格遵守 InspectorCat system prompt 的 version 1 JSON 合同。
