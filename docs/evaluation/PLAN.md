# Evaluation PLAN

状态：Active
最后更新：2026-10-09
Owner：Runtime / Evaluation maintainers

## Current Status

- 已实现 24 个连续协作 Case、三个明确 baseline、隔离真实模型 Replay 和 shared Evaluation/Reviewer 组合入口；比较报告仅投影 Outcome，blocked 不被藏掉。
- 工程验证已覆盖实际异步/同步 loop、文件记忆与相同上下文重置、生产 ReminderStore/Event 去重，以及评分和通知指标边界。真实模型量化尚未运行：当前云环境没有模型凭据；本地验收需 `--live`。

- Test / Eval / Trace / Case / Replay 的语义边界已确定。
- 轻量 `Case + Oracle → Replay → Trace → Verifier → ReviewerCat → Outcome` 核心已实现并测试。
- Case Replay adapter 已能驱动当前 Pet/Agent Runtime，并且只返回 fresh Trace ref；生产默认通过隔离子进程执行。
- ReviewerCat Judge adapter 使用独立只读 Session 和结构化输出。
- Outcome 只保留 `pass | fail | blocked`；EvaluationResult 只保存事实。
- BaseRuntime 预写响应已迁到 `test/scripted-runtime/**`、`src/testing/**` 和 `output/test/**`。
- 旧 Scripted Runtime Test engine 已整体移入 `src/testing/**`；`src/eval/**` 只保留真实 Agent Eval。
- 真实 CaseSet CLI 已接入；Verifier registry 保持为 `trace_exists`、`no_failed_tools` 与 `read_only_tools` 三项。
- 首个维护中的 `xiaoba-core-readonly-v1` 已建立，包含 Base、EngineerCat、ReviewerCat 三条真实 Agent Case。
- Replay 默认只读；`workspace_write` 必须显式声明并由 enforced clean runtime 承载，外部 delivery / Browser / GUI / Secretary 工具不进入 Replay。
- Arena 默认命令与 nightly Evolution 已调用同一个 Evaluation core。

```mermaid
flowchart LR
    Done["Core contracts + orchestration"] --> Partial["Production adapters"]
    Partial --> Default["Default Eval CLI"]
```

## Milestones

1. 明确 Test / Eval / Replay 边界：completed。
2. 实现轻量 Evaluation core：completed。
3. 实现 ReviewerCat shared Judge adapter：completed。
4. 实现 Case Replay adapter：completed。
5. 将 Scripted Runtime Test 移出 Eval 公共语义：completed。
6. 接入最小生产 Verifier registry：completed；后续按真实 Case 需求扩展。
7. 提供真实 CaseSet CLI：completed。
8. 将旧 Eval-named Test engine 文件移出 `src/eval`：completed。
9. 建立首个维护中的真实 CaseSet：completed。
10. 建立 Replay effect isolation：completed for default read-only and SDK clean-runtime workspace-write; unsupported hosts fail closed。

## Next Steps

- 本地先执行 `--live --case interrupt --runs 1`，核对新鲜 Trace 和 Reviewer 判定，再执行 24 Case × 2 版本 × 3 轮。人工标注补救次数后才可报告该数字；当前未测得。

- 只在真实 Case 需要时增加新的 hard Verifier，避免搬回旧巨型 verifier registry。
- 用真实回归逐步扩充当前 CaseSet，不先造 benchmark taxonomy。
- 只在实际维护相关代码时逐步收敛 `src/testing/**` 内部旧 `Eval*` 类型名，不单独发起机械改名。

## Owners

- Shared Eval：`src/eval/evaluation.ts`
- Reviewer Judge：`src/eval/reviewer-cat-judge.ts`
- Replay：`src/replay/**`
- Scripted Runtime Test：`src/testing/**`, `test/scripted-runtime/**`

## Acceptance Criteria

- 预写模型响应永远不被报告为 Agent Eval。
- Replay 驱动真实 Agent、产生 fresh Trace，且不输出 pass/fail。
- Replay 缺省只暴露只读工具；写入模式必须在 enforced clean runtime 中执行。
- 每个 execution 只有一个 Outcome。
- Verifier hard failure 否决 Reviewer pass。
- ReviewerCat fresh、只读、结构化，且看到同 Case 的全部 runs。
- Arena 和 Evolution 调用同一个 Evaluation runner。
- Report 和可选 Gate 不产生第二份权威 Result。

## Risks / Open Questions

- `workspace_write` uses the shared SDK on supported Linux/macOS hosts; missing isolation fails closed。
- 当前维护 CaseSet 只有三条只读 Case，尚不代表广泛 Agent 能力。
- 旧 Test engine 的内部类型仍带少量 `Eval*` 名称；它们已被限制在 `src/testing/**`，后续随实际修改逐步收敛。

## Recent Verification

- 2026-10-09：连续协作 + async regression 工程测试 18/18；`npm run build` passed；dry-run 24 Case / 48 trajectories passed。没有把工程测试数字计为真实 Agent 能力。
- 2026-10-09：完整工程测试 711 项，710 passed、1 failed；失败为既有 `evolution-sleep.test.ts:242` 容器 PID 1 未回收子进程的 SIGKILL/zombie 断言，与上次基线一致。未跳过或弱化测试。

- `npm run build` passed。
- 清理后 `npm test` passed 556/556 across 100 suites。
- Scripted Runtime Test focused tests passed 45/45。
- Contract smoke passed 23/23。
- `npm run test:base-runtime -- --allow-fail` passed 11/11。
- `npm run test:check-scripted-runtime` passed 1 manifest / 11 cases。
- Source Candidate、Replay isolation 与 maintained CaseSet focused tests passed 22/22 across 6 suites。
- 旧 `src/eval` Test engine 路径引用检查为零，`git diff --check` passed。


## Unified sandbox execution

Owner: Evaluation / Runtime. Completed: Source Candidate build, ordinary tests and native-contract phase use shared SDK isolation; no candidate test code is launched directly on the host. Replay keeps its explicit workspace_write gate. Linux source-fixture build/test and shared SDK boundaries passed. Full verification and unsupported-platform limits are in `../agent-runtime/PLAN.md`.
