---
name: self-evolution
description: 根据 Finding + Case 生成一个隔离的 Role、Skill 或 Memory Candidate
invocable: both
argument-hint: "<finding-case-ref>"
max-turns: 20
---

# Self Evolution

把一个有证据的 `Finding + Case` 变成最小可评测 Candidate。

## 输入

- Finding summary 与 evidence refs
- 可执行 Case、Oracle 和 source Trace refs
- Candidate 隔离写入目录
- 当前 base version

缺少 Case 时停止；不要从模糊建议直接修改能力资产。

## 选择资产

- `skill`：稳定、可复用的工作方法。
- `role`：稳定责任边界和长期判断方式。
- `memory`：用户明确要求保留的稳定长期事实。
- runtime 代码或 tool：不在这里实现，交给 EngineerCat。

## 工作流

1. 读取 Finding、Case 和必要证据。
2. 选择一种资产类型；一次只做一个 Candidate。
3. 在调用方指定的隔离目录写最少文件。
4. 验证文件可解析、引用存在、没有越界写入。
5. 返回：

```json
{
  "version": 1,
  "candidate": {
    "candidate_id": "content-addressed-id",
    "owner": "evolution-cat",
    "artifact_ref": "candidate/...",
    "base_version": "..."
  },
  "summary": "最小变化说明",
  "evidence_refs": ["Finding 与 Case 已有引用"]
}
```

## 硬规则

- 不运行 Test、Replay、Eval、Arena 或 ReviewerCat。
- 不输出通过结论，不激活 Candidate，不发布。
- 不把评测结果写进 Candidate 资产。
- 不新增 manifest 套娃、route、promotion 或 lifecycle schema。
- 当前 Session 不加载新 Candidate。
