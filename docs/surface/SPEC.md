# Surfaces SPEC

状态：Active
最后更新：2026-07-29
适用范围：XiaoBa 的用户入口层，包括 `src/commands`、`src/feishu`、`src/weixin`、`src/pet`、`src/dashboard` 和 `desktop`。

本文件是顶层架构模块之一的入口层 spec，也是 Dashboard、Electron 和 packaging 资源的唯一架构文档。

## Problem

Surfaces 把不同用户入口统一接到同一套 local-first agent harness。CLI、Feishu、Weixin、Pet、Dashboard 和 Electron 桌面壳的协议、鉴权、事件形态和用户可见输出不同，但它们不能各自实现一套 agent loop。

入口层要解决的问题是：

- 把平台消息解析成 runtime 可消费的 user turn。
- 显式声明 `surface`、session key 和 channel callbacks。
- 将用户可见文本、文件和错误交付回对应平台。
- 保持平台适配和 agent harness 的责任边界清楚。

## Scope

In scope:

- CLI 命令入口：`src/commands/**`。
- IM 平台入口：`src/feishu/**`、`src/weixin/**`。
- Pet 和 Dashboard 入口：`src/pet/**`、`src/dashboard/**`、`desktop/dashboard/**`。
- Electron 桌面壳和桌面打包资源：`desktop/electron/**`、`desktop/build-resources/**`。
- 入口级 session key、channel callbacks、文件上传下载、SSE、service control 和配置入口。

Out of scope:

- Provider 调用和 transcript 修复，属于 `docs/agent-runtime/SPEC.md`。
- Role/skill 策略，属于 `docs/roles-skills/SPEC.md`。
- trace、visible history、memory、artifact 的观测证据和持久化 schema，属于 [`../observability-evidence/SPEC.md`](../observability-evidence/SPEC.md)。
- Unit、integration、deterministic smoke、Replay 和 Live Agent Eval 的语义，属于 [`../evaluation/SPEC.md`](../evaluation/SPEC.md)。

## Current Architecture

当前入口层已经收敛到共享 `AgentSession`，但各入口仍分别维护平台协议、文件语义和服务控制。CLI 的 `evolution sleep` 与 schedule 已进入轻量 Evolution control；manual `evolution promote` 已删除。Channel delivery 的 canonical prompt 集中在 `prompts/surface.md`。Pet/Dashboard 的 role-scoped session key 已绑定到对应 SkillManager / ToolManager，并在 Chat 与桌宠间共享历史和 SSE replay。Dashboard 只展示、选择、安装或删除当前 Role/Skill package，不再维护 capability lifecycle。macOS Electron 只打包 GuiCat 的固定 Peekaboo driver。入口级文本、文件和 external receipt 由 deterministic Test 覆盖。

```mermaid
flowchart LR
    CLI["CLI"] --> Adapters["Surface adapters<br/>commands / protocol / callbacks"]
    Channels["Feishu / Weixin / Pet / Dashboard / Electron"] --> Adapters
    Adapters --> Session["Shared AgentSession<br/>role-scoped services"]
    Session --> Delivery["Terminal / IM / SSE<br/>visible delivery evidence"]
    CLI --> Sleep["schedule / evolution sleep"]
    Sleep --> Control["Lightweight Evolution control"]
    Control --> TestEval["shared Test + Eval"]
    TestEval --> Activation["Atomic activation<br/>capability: new Session<br/>code: next process"]
```

## Target Architecture

目标是让所有入口都显式实现同一套 surface contract：平台层只做输入解析、鉴权、文件处理和交付回调，agent loop、role/skill、tool、state/evidence 都由下游模块统一承担。

```mermaid
flowchart LR
    Entrypoints["CLI / IM / Pet / Dashboard / Electron"] --> Contract["One surface contract<br/>auth / session / files / callbacks"]
    Contract --> Runtime["Shared agent runtime"]
    Runtime --> Delivery["Visible delivery + evidence"]
    Delivery --> Conversation["Conversation Journal<br/>visible messages only"]
    Delivery --> Verify["Surface contract tests"]
    Verify --> Contract
    CLI["CLI control plane"] --> Evolution["Lightweight Evolution trigger"]
    Evolution --> TestEval["shared Test + Eval"]
    TestEval --> Activate["Atomic activation<br/>capability: new Session<br/>code: next process"]
```

## Contracts

- 每个入口必须显式传入 `surface`，不能从 session key 反推入口类型。
- 每个入口的用户输入和实际可见交付必须进入共享 Conversation Journal；未交付 final text、thinking 和 tool internals 不得写入该 Journal。
- Feishu Surface 配置的 App ID 是 XiaoBa 飞书能力的 canonical application identity。SecretaryCat 使用官方 `lark-cli` 时必须选择 App ID 相同的 profile；`bot` 和 `user` 是同一应用下的 actor identity。XiaoBa 不复制凭据存储，也不隐式切换 `lark-cli` 的全局 active profile。
- 每个入口的 raw event / route payload 应能归一化为稳定 surface event：surface、event type、event id、session key、channel id、user id、user message、payload type 和必要 metadata。
- Pet/Dashboard 的 `pet:<petId>:role-<role>` session key，以及 `pet:<petId>:role-<role>:<safe-suffix>` 这类带附加隔离后缀的 session key，必须创建或复用对应角色的 scoped services；`/skills`、skill 激活、tool allowlist、visible history 和 SSE replay 都必须按归一化后的 session key 隔离，`role-base` 归一到默认 `pet:<petId>`。
- Arena 可在进程内构造 PetChannel 时设置不可由 HTTP body 覆盖的 `requiredActiveSkillName`；它必须在每条 queued Pet message 前重新激活同一个 subject Skill，缺失时 fail closed。普通 Pet / Dashboard / Base / CLI 不设置该字段，行为保持不变。
- CLI 的正常用户可见输出是 direct final reply；CLI 不应向模型暴露 `send_text` / `send_file`。
- Feishu、Weixin、Pet 和 Dashboard 这类 channel-backed surface 的正常用户可见输出是 `send_text` / `send_file` 或等价 channel callback；direct final reply 默认只进入 provider/session trace，不外发给用户。
- Channel delivery prompt 的 canonical source 是 `prompts/surface.md`；surface system message 和 role prompt 只能读取或 include 这份规则，不应复制维护另一份完整文本。
- Channel final reply fallback 是显式 opt-in：入口只有传入 `deliveryFallbackFinalReply=true` 时，`ConversationRunner` 才能把 final text 合成为 synthetic `send_text` 交付证据；默认关闭。
- 当 `AgentSession.handleMessage` 返回 `finalResponseVisible=true` 且带有 `text` 时，channel adapter 必须把该文本通过当前 channel callback 交付给用户；这是 runtime 显式标记的可见结果，不等同于默认关闭的 final reply fallback。
- `send_text` / `send_file` 属于 surface tool，只能在入口显式传入 channel-backed `surface` 且提供真实 `channel` callbacks 时注入；slash command 激活 skill 后继续进入 agent loop 时也必须保留同一组 `surface` / `channel`。
- 入口 runtime smoke 必须捕获 request/response artifacts、IM reply 或 SSE events、session key、channel id、visible delivery count、file delivery count 和 file names。
- 真实入口 E2E 若覆盖 auth、upload/download、long task queue、session restore/resume 或跨平台用户路径，必须进入 ReviewerCat / role benchmark 边界，而不是扩张 runtime harness。
- 平台层只负责鉴权、消息解析、文件上传下载、callback 和服务控制，不复制 `ConversationRunner`。
- 新增入口必须定义 session key 规则、用户可见输出语义、文件处理、TTL/cleanup/wakeup 行为。
- Platform-specific optional drivers 必须只进入对应平台的安装包，并落在 role adapter 已声明的固定资源路径；不得把 driver-side Agent/MCP 一并暴露给 runtime。
- Dashboard/Pet 这类本地 HTTP surface 在扩大网络暴露前必须先有 auth、permission 和 command/path validation。
- Dashboard 不拥有 Candidate lifecycle 或裁决动作；它只展示当前 package，Evolution activation evidence 仍由原始只读产物提供。
- Candidate 通过 shared Test + Eval 后由 Evolution 调用 runtime-owned atomic activation；Role/Skill 只影响新 Session，code 只影响下一进程，Surface 不参与裁决。

## Interaction With Other Modules

- 调用 `docs/agent-runtime/SPEC.md` 定义的 `AgentSession` 和 runner，不直接调用 provider。
- 使用 `docs/roles-skills/SPEC.md` 定义的 role/skill policy，不自行拼接角色运行时。
- 将可观测输出写入 [`../observability-evidence/SPEC.md`](../observability-evidence/SPEC.md) 定义的 trace、visible history 或 artifact evidence。
- 入口级 deterministic contract smoke 由 `test/contract-smoke/suites` 维护；Feishu 和 Pet 的入口 Runtime 最小闭环由 `test:surface-runtime` 覆盖，文件与 receipt shape 由 `test:surface-runtime-file` 覆盖。预写响应的 BaseRuntime 覆盖由 `test:base-runtime` 执行，不属于 Agent Eval。
