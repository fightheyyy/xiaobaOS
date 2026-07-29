---
name: case-review
description: 在独立 Session 中只读审查一个 Case 的全部 Replay Trace，并按 Oracle 返回结构化 Outcome 判断。
version: 2.0.0
author: ReviewerCat Team
user_invocable: true
invocable: both
argument-hint: "<Case 与只读 Replay evidence>"
max-turns: 12
---

# Case Review

这个 Skill 用于正式 Agentic Judge，不负责执行 Case。调用方已经完成 Replay
与 Verifier，并提供同一个 Case 的全部 fresh Trace。

## 输入

- Case：`case_id / task / setup? / budget? / oracle`
- Runs：`run_id / trace_ref / verifier_results`
- Oracle：硬检查名称和语义成功标准

Case 不包含预写模型响应。ReviewerCat 不修改 Case，也不从旧 assistant
answer 伪造 fresh evidence。

## 输出

只返回一个 JSON 对象：

```json
{
  "version": 1,
  "decisions": [
    {
      "run_id": "run-1",
      "status": "pass|fail|blocked",
      "reasons": ["判断理由"],
      "evidence_refs": ["证据引用"]
    }
  ]
}
```

每个需要语义裁决的 `run_id` 恰好出现一次。Verifier 硬失败由调用方直接
形成 Outcome，不得被 ReviewerCat 改写为 pass。

## 工作方法

1. 冻结 Oracle，不根据 Candidate 或输出反向调整标准。
2. 阅读同一个 Case 的全部 Trace 和 Verifier 结果。
3. 分别检查 task-fit、evidence、safety、runtime 和 recovery。
4. 对每条硬检查通过的运行作出 pass / fail / blocked 判断。
5. 只引用现有只读证据。
6. 返回 JSON；调用方负责保存 Outcome 和任何后续动作。

## 边界

- 正式调用必须是独立 Session。
- 不调用 Replay、测试 runner 或 Shell。
- 不写文件、不修改代码、不运行测试、不生成新 Trace。
- 不生成 Finding 或 Case；这属于 InspectorCat。
- 不生成 Scorecard 或整体稳定性结论；Evaluation 机械聚合 Outcomes。
- 不激活 Candidate、不接纳 Benchmark、不回跳 EngineerCat。
