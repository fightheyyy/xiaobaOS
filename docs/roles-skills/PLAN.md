# Roles & Skills PLAN

状态：Active
最后更新：2026-08-03
Owner：Policy maintainers

## Current Status

- Base 是唯一 user-facing Main Agent。
- 默认发行物包含八个 Role 和零个 Base Skill。
- EngineerCat、BrowserCat、GuiCat、SecretaryCat 负责执行接管。
- GuiCat typed desktop adapter 继续限定在窄 macOS GUI driver 边界内。
- UserCat、InspectorCat、ReviewerCat、EvolutionCat 是共享 Assurance & Evolution 角色。
- UserCat 已移除两个规划型 local Skills；只保留兼容 trace Tool，并新增 Scenario proposer。
- InspectorCat 已删除 shadow task 子系统与四个多余 Skills；现在只做 Finding+Case。
- ReviewerCat 已删除三个专用评测 Tools；现在是共享只读 Judge。
- EvolutionCat 的运行时资产和 control workflow 已瘦身，`evolution sleep` 已切为默认入口。
- Role/Skill Candidate 已接入 shared Test、shared Eval 与原子 next-Session activation。
- code Finding 已接入显式 EngineerCat Source Candidate adapter；候选在隔离源码副本中完成完整 Test + Eval，再事务性激活 source + dist 并于下一进程生效。
- EngineerCat 已接入唯一 `codex_run` Tool，复用官方 SDK 的 start/resume，并保留原生 coding fallback；未恢复 job manager/supervisor。
- 旧 nightly typed DAG、patch workspace/regression、manual promote CLI 与专用 Reviewer replay Tool 已删除。
- runtime Candidate lifecycle、Dashboard Promote/Unblock API/UI 与 `CapabilityStatus` 类型已删除。
- 发行目录中的 Role/Skill 一律作为已安装 package 加载；旧 `status` 元数据被忽略。

```mermaid
flowchart LR
    Roles["Role boundaries simplified"] --> Workflow["Lightweight Evolution workflow"]
    Workflow --> Activation["Shared Test / Eval / activation"]
```

## Milestones

1. Base + eight-role topology：completed。
2. Base zero-default-Skill：completed。
3. UserCat Scenario-only boundary：completed。
4. InspectorCat Finding+Case boundary：completed。
5. ReviewerCat shared Judge boundary：completed。
6. Lightweight Evolution control DAG：completed at orchestration boundary。
7. 删除 dead Inspector/Reviewer assets：completed。
8. 替换旧 nightly Evolution entry：completed。
9. 移除 manual promotion 和 Candidate lifecycle UI/loader：completed。
10. 生产级 next-Session atomic activation adapter：completed for Role/Skill。
11. EngineerCat Source Candidate adapter：completed for code Findings and next-process activation。
12. EngineerCat Codex execution adapter：completed；official SDK behind one role Tool, native fallback retained。

## Next Steps

- 按真实需求决定是否增加 Memory Candidate adapter。

## Owners

- Role assets：`roles/**`
- Runtime role adapters：`src/roles/**`
- Shared Reviewer Judge：`src/eval/reviewer-cat-judge.ts`
- Skill runtime：`skills/**`, `src/skills/**`

## Acceptance Criteria

- 只有 Base 面向用户并派遣 Role。
- 所有 Role 使用同一个 XiaoBa Agent loop。
- UserCat 只模拟用户或生成缺省 Scenario。
- InspectorCat 只输出 evidence-backed Finding+Case。
- ReviewerCat formal Judge fresh、只读、结构化。
- EngineerCat 只负责 code Candidate；EvolutionCat 只负责 Role/Skill/Memory Candidate。
- Evolution 只调用 shared Test + Eval，不拥有重复实现。
- pass Role/Skill Candidate 只对新 Session 激活；pass code Candidate 只对下一进程激活；其他结果不改变当前版本。
- 不引入 RouterCat、Recovery Role 或通用任务框架。

## Risks / Open Questions

- Source Candidate 的完整 Test 依赖 enforced native sandbox；当前仅 macOS 可执行，其他平台 fail closed。
- 自动激活必须保留原版本，以便失败时回滚，但不应演化成新的 lifecycle subsystem。
- BrowserCat/GuiCat/SecretaryCat 的外部 driver 可用性仍是独立运维风险。

## Recent Verification

- `npm test` passed 561/561 across 102 suites。
- EngineerCat 相关 focused tests passed 31/31 across 5 suites；真实官方 SDK read-only start/resume smoke 保持同一 thread id，且没有文件改动或外部工具调用；macOS arm64 packaged adapter resume 也通过。
- 真实 EngineerCat production-path E2E 经共享 Agent loop 新建 Codex thread，并在下一用户轮指定返回的 `thread_id` 成功续接；角色仍只暴露一个 Codex Tool。
- Role/Skill 生命周期清理 focused tests passed 42/42 across 9 suites。
- Shared Arena/Evolution core focused tests passed 45/45 across 8 suites。
- Lightweight Evolution workflow tests passed 4/4。
- Source Candidate、Replay isolation 与 maintained CaseSet focused tests passed 22/22 across 6 suites。
- 真实 Source Candidate 验收完成完整 build、普通仓库测试与独立 native-sandbox contract phase，结果为 pass；未激活生产源码。
- ReviewerCat Judge tests passed 3/3。
- Inspector Finding+Case tests passed 4/4。
- UserCat Scenario tests passed 3/3。
- `npm run build` passed。
