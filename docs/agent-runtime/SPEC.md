# Agent Runtime SPEC

状态：Active
最后更新：2026-08-03
适用范围：XiaoBa 的核心 agent harness runtime，包括 `src/core`、`src/providers`、`src/tools`、`src/types/tool.ts` 和 runtime-facing harness docs。

本文是顶层架构模块之一的 Agent Runtime spec。它定义 agent loop、provider transcript、tool boundary 和 session lifecycle；入口、角色策略、观测证据、评测和 Arena 分别由各自模块 spec 维护。

## Problem

Agent Runtime 把用户输入、角色策略、技能、工具、provider 调用和运行证据组织成一个可恢复、可观测、可评测的状态机。模型不是 runtime；runtime 必须保证 transcript 合法、tool 调用闭环、失败可观测、上下文压缩不丢当前任务。一次用户请求到本次 `ConversationRunner` while loop 截止叫 `trace`；while loop 的内部推进才叫 `turn`。`episode_id` 只作为历史兼容 alias 保留。

## Scope

In scope:

- `AgentSession` 生命周期、busy/interrupt、restore、context compression 和 memory cleanup。
- `ConversationRunner` 的 model call -> tool calls -> tool results -> next model call 循环。
- Provider adapters：`src/providers/**`。
- Tool boundary：`src/tools/**`、tool layer、tool schema、参数解析、执行结果、错误码和 retryable 语义。
- Sub-agent/session runtime：`src/core/sub-agent-*`。
- Runtime 类型契约：`src/types/**` 中与 session/tool/provider 相关的类型。

Out of scope:

- 平台入口协议和用户可见交付，属于 `docs/surface/SPEC.md`。
- Role/skill policy，属于 `docs/roles-skills/SPEC.md`。
- 日志、artifact 和 trace projection 的持久化证据边界，属于 [`../observability-evidence/SPEC.md`](../observability-evidence/SPEC.md)。
- Test、Case Replay、Verifier、Reviewer Judge 和 EvaluationResult 归 [`../evaluation/SPEC.md`](../evaluation/SPEC.md)。

## Current Architecture

当前 runtime 已经以 `AgentSession` 和 `ConversationRunner` 为主线，入口和角色最终都进入同一套 runner。`PromptManager` 负责读取 role/base prompts、展开 `{{include:...}}` prompt fragments，并通过 `prompts/surface.md` 向 `AgentSession` 提供共享 channel delivery prompt。ToolManager 支持 base / role / surface 三层过滤，并已增加 role 声明式 `skill_scoped` 可见性 resolver 与 confirmed tool gate；隔离 runtime 可以显式注入已经从 snapshot 解析的 `roleConfig`，从同一个 ToolManager 计算真实 registered/provider-visible tool 集，而不修改进程级 role 环境。confirmed gate 现在分成 provider-visible 的无否定显式确认检查和 execution-time payload binding 检查，确认类工具即使被硬调也必须让 tool args 与最近确认 turn 或上一条 assistant 提案形成可验证匹配。ConversationRunner 每次 provider request 前都会用当前 active skill 重新解析 provider-visible tools；channel surface 默认只有显式 `send_text` / `send_file` 会产生用户可见输出，final text 只写入 provider/session trace，不自动外发。`delivery_fallback_final_reply` 保留为显式 opt-in 策略，开启时才记录 synthetic `send_text` ToolResult、`delivery_evidence` 和可选 external receipt。Tool result 现在通过 `src/tools/tool-result.ts` 的 canonical builder/canonicalizer 统一收口，覆盖 ToolManager、AgentToolExecutor、SubAgent forbidden results 和 ConversationRunner retry/cancel/fallback delivery results，保证 status/error_code/retryable/duration evidence v1 不再由各 executor 分散拼装；live `ToolExecutionOutput` 也可显式声明 `status/error_code/blocked_reason/retryable/retry_budget`，ToolManager 和 AgentToolExecutor 会优先使用这些结构化字段，只有 legacy string output 才进入中文/英文前缀分类兼容路径。core tools 以及 ResearcherCat / InspectorCat / ReviewerCat / UserCat maintained role tools 已能产出显式 artifact evidence，AgentToolExecutor 也会保留 `Tool.getArtifactManifest()` 的 tool-owned evidence；EngineerCat 通过显式 allowlist 复用文件、搜索、Shell、Skill、子侧 `ask_parent` 及同一个 evidence contract，不继承 Base 的父侧 SubAgent 调度控制工具。structured outbound delivery evidence 已有 `delivery_evidence_contract` v1 hard verifier，覆盖 deterministic `send_text` / `send_file` 正负例、opt-in fallback final reply evidence 以及 production entrypoint Surface Runtime / Surface Runtime File replay；Surface Full deterministic gate 现在还固定 message/file/upload/download 的 external delivery receipt shape；`session-log-v2` provider transcript boundary 现在还有 schema semantic gate，拒绝把 raw messages/tool payload 放进 provider transcript ref；`src/observability` 维护本地 summary、local metric/span helpers 和 trace continuity，并能显式启用一个脱敏、fail-open 的 OTLP trace exporter；provider/durable/working trace 的严格分离仍在推进中。

Current addendum：EngineerCat 现在通过唯一 role-scoped `codex_run` 调用官方 `@openai/codex-sdk`。该窄适配器从可信 `ToolExecutionContext` 取得 cwd 和 AbortSignal，模型只能提供 task、只读/可写模式和可选 `thread_id`。它关闭 Codex web/network、已配置 MCP server、plugins、hooks 和 multi-agent，过滤传入子进程的环境，并把 usage、命令摘要、文件变更、artifact 和失败归一为标准 ToolResult。Arena clean runtime 和确定性 Source Candidate builder 都 fail closed，不会产生未计费的外部模型调用。XiaoBa 不维护 Codex job manager/supervisor，原生 coding tools 保留为小修改和降级路径。

Current addendum：live `AgentSession` provider/model failure path now emits a structured `runtime_event` with `event_type=provider_error` before writing the fallback turn. The event records provider error facts (`provider`、`model`、`endpoint`、`status`、`error_code`、`retryable`、`message`) plus surface, token counters and session-local provider failure budget facts (`status`、`retry_count`、`retry_budget`、`retry_budget_exhausted`、`blocked_reason`、`provider_failure_budget`). Consecutive same-fingerprint retryable provider failures converge to `status=blocked`; non-retryable provider failures are blocked immediately.

Current addendum：the same live provider/model failure path now marks the fallback turn's provider transcript boundary as degraded without retaining raw provider transcript payload. `AgentSession` emits `state_boundary.provider_transcript.ref=provider-transcripts/sha256:<digest>` for all turns; provider failure turns add `status=degraded|blocked`、`degraded=true`、`degradation_reason/error_code`、`fallback_chain`、`blocked_reason` and explicit false raw payload flags. This means local live runtime evidence now matches the Contract Sentinel provider transcript degradation shape, while production-network cross-provider orchestration remains future work.

Current addendum：`scripts/check-provider-network-readiness.ts` adds an opt-in live provider-network readiness runner around the existing `AgentSession` path. By default the runner returns structured `blocked` environment evidence; with `--enable` or `XIAOBA_PROVIDER_NETWORK_REPLAY=true` and explicit provider config, it exercises a live provider call inside an isolated workspace and checks for `provider_error` runtime_event evidence plus degraded provider transcript boundary facts. This keeps the production user path simple while creating a concrete bridge toward production-network degradation replay.

Current addendum：Contract Boundary now also fixes deterministic cross-adapter failover sequence evidence. `provider_failover_sequence` verifies ordered `provider_error` events across OpenAI-compatible、Anthropic and Ollama attempts, including endpoint/error_code order, retry budget facts, monotonic timestamps and terminal blocked reason. This is a release contract for evidence shape; live production-network failover orchestration remains target architecture work.

Current addendum：context compression now emits structured runtime evidence. `AgentSession` records restore / pre-message compaction, and `ConversationRunner` records pre-request compaction inside tool loops. Each successful compaction writes a `context_compaction` event plus a compact-after snapshot in the owning session log directory, so replay/debug consumers can anchor later behavior to the post-compact working memory without storing full pre-compact context by default.

Current addendum：EvolutionCat 的 `remember` 是 role-scoped deterministic tool。它复用 `MemoryFinalizer` 的 session-person Markdown 合同，优先按可信 `parentSessionId`、否则按当前 `sessionId` 哈希写入 `memory/sessions/<hash>/MEMORY.md`，返回 canonical ToolResult 和 tool-owned artifact evidence；它不是 Skill，也不会对 Base 或其他角色注册。

Current addendum：每个 `SubAgentSession` 写入独立的标准 `logs/sessions/subagent/**/traces.jsonl`。terminal row 保留可信 parent、role、skill、ToolResult 和 artifact lineage。`evolution sleep` 已调用轻量 Evolution control workflow，旧 typed-route runner 已删除；Evolution 只组合共享 Test、Eval 与 capability new-Session / code next-process activation。

Current addendum：Case Replay 现在默认使用专用只读 ToolManager，只暴露 `read_file`、`glob` 与 `grep`；正式 Case adapter 还会放入隔离子进程。显式 `workspace_write` Case 只有在 Arena/Evolution clean runtime 设置 enforced sandbox 时才能获得候选工作区的文件与 Shell 工具；delivery、Browser、GUI 和 Secretary 工具始终不注册。Source Candidate Test 复用 macOS Seatbelt：允许读取系统 runtime 与依赖、禁止读取生产源码，并且只允许写候选副本、测试临时目录与一次性 BrowserCat 短 runtime 根；两个会自行创建原生沙箱的 contract test file 单独运行其自身 sandbox，避免无意义的 sandbox nesting。沙箱不可用时 fail closed。

Current addendum：code Finding 通过一次性 `delegate_code` 从 EvolutionCat 路由到 EngineerCat。EngineerCat 仍运行同一个 `SubAgentSession` / `ConversationRunner` loop，只在 secret-free 源码副本内写入。确定性 Source Candidate builder 显式隐藏 `codex_run`，候选完成完整 build、repository tests 和 shared Eval 后，source + dist 以可回滚文件事务替换，并只由下一进程加载；这不是第二套 XiaoBa runtime 或 Candidate lifecycle。

Current addendum：显式配置 `allowedWriteRoot` 的窄 SubAgent workflow 现在同时约束文件写工具和 Shell。`write_file` / `edit_file` 拒绝绝对路径、`..` 与 symlink escape；macOS Shell 通过 Seatbelt 包装，允许广泛读取但只允许写 `allowedWriteRoot`，HOME/TMP 也落在该根目录。Seatbelt 不可用时该受限 Shell fail closed，普通未配置 `allowedWriteRoot` 的 SubAgent 行为不变。EngineerCat 没有独立的内层写控制面，Scheduled Repair 直接在这套共享工具边界内运行。

```mermaid
flowchart LR
    subgraph Inputs["Inputs"]
        SurfaceTurn["surface user turn"]
        EvolutionTrigger["scheduled evolution trigger"]
        RolePolicy["role prompt / tool policy"]
        SurfaceContext["surface context"]
        SkillPolicy["active skills"]
        Memory["memory context"]
    end

    subgraph Runtime["Runtime"]
        Session["AgentSession"]
        Subagent["SubAgentSession"]
        PromptManager["PromptManager<br/>prompts + includes"]
        Compressor["ContextCompressor"]
        Runner["ConversationRunner"]
        Provider["Provider adapters<br/>OpenAI / Anthropic / Ollama"]
        ToolManager["ToolManager<br/>base / role / surface visibility"]
        Visibility["ToolVisibilityResolver<br/>all / skill scoped + confirmed gate"]
        Tools["src/tools"]
        Observability["Observability<br/>local summary + optional OTLP trace"]
        CompactEvidence["compact evidence<br/>event + after snapshot"]
        EvolutionControl["Evolution control<br/>shared Test + Eval"]
        WriteBoundary["SubAgent write boundary<br/>path guard + Seatbelt"]
        CodexAdapter["EngineerCat codex_run<br/>official SDK boundary"]
        CodexThread["local Codex thread<br/>start / resume"]
    end

    subgraph Outputs["Outputs"]
        Reply["assistant reply / fallback"]
        ToolResults["tool results"]
        SessionLog["session JSONL"]
        Artifacts["artifacts"]
    end

    SurfaceTurn --> Session
    EvolutionTrigger --> EvolutionControl
    EvolutionControl --> Subagent
    Session --> Subagent
    Subagent --> WriteBoundary
    WriteBoundary --> ToolManager
    RolePolicy --> PromptManager
    SurfaceContext --> PromptManager
    PromptManager --> Session
    RolePolicy --> Session
    SurfaceContext --> Session
    SkillPolicy --> Session
    Memory --> Session
    Session --> Compressor
    Compressor --> CompactEvidence
    Session --> Runner
    Runner --> Provider
    Provider --> Runner
    Runner --> ToolManager
    ToolManager --> Visibility
    ToolManager --> Tools
    ToolManager --> CodexAdapter
    CodexAdapter --> CodexThread
    CodexThread --> ToolResults
    Tools --> ToolResults
    ToolResults --> Runner
    Runner --> Reply
    Session --> SessionLog
    Subagent --> SessionLog
    Tools --> Artifacts
    Session --> Observability
    Runner --> Observability
    CompactEvidence --> SessionLog
```

## Target Architecture

目标是把 provider transcript、trace 和 durable session 分清楚，并把 tool result、delivery evidence、runtime failure 和 retry budget 升级为结构化事实。Provider adapter 必须作为可扩展边界存在：OpenAI-compatible、Anthropic Messages 和 Ollama native `/api/chat` 都要统一归一到 `ChatResponse` / `Message` / `ToolDefinition` 合同，而不是把 provider-specific transcript 泄漏到 runner。工具可见性必须支持 role 声明式策略：默认角色继续看到三层 ToolManager 过滤后的工具；显式配置的弱模型/窄动作角色可以通过 active skill 激活 scoped toolsets，并由 runtime 强制执行确认类工具 gate。

```mermaid
flowchart LR
    subgraph Inputs["Inputs"]
        Surface["surface contract"]
        Policy["role / skill policy"]
        SurfacePolicy["surface delivery policy"]
        Durable["durable session state"]
        Scheduled["scheduled evolution trigger"]
    end

    subgraph Harness["Harness runtime"]
        Session["AgentSession lifecycle"]
        Subagent["SubAgentSession lifecycle"]
        Trace["trace"]
        Transcript["provider transcript"]
        Runner["ConversationRunner"]
        Tools["layered ToolManager"]
        Resolver["ToolVisibilityResolver<br/>role policy + active skill"]
        VisibleTools["provider-visible tool set"]
        Providers["provider adapters<br/>OpenAI / Anthropic / Ollama native"]
        EvolutionControl["Evolution control<br/>Trace or Case input"]
        Activation["Atomic version activation<br/>capability: new Session<br/>code: next process"]
        WriteBoundary["bounded SubAgent writes<br/>path guard + native sandbox"]
    end

    subgraph Facts["Structured facts"]
        ToolResult["ToolResult status/error_code"]
        Delivery["delivery evidence"]
        RuntimeEvent["runtime event"]
        Artifact["artifact manifest"]
        LocalSummary["observability local summary"]
        OtelTrace["OTLP trace projection<br/>optional + redacted"]
        DriverResult["external driver result<br/>trust / version / outcome"]
    end

    subgraph CodingExecutor["Optional coding executor"]
        CodexAdapter["EngineerCat codex_run<br/>fixed cwd + access mode + abort"]
        CodexThread["local Codex thread<br/>start or resume"]
    end

    subgraph Downstream["Downstream"]
        Evidence["state/evidence"]
        Gates["contract tests / benchmarks"]
    end

    Surface --> Session
    Policy --> Session
    SurfacePolicy --> Session
    Durable --> Session
    Scheduled --> EvolutionControl
    EvolutionControl --> Subagent
    EvolutionControl --> Trace
    EvolutionControl --> Activation
    Session --> Trace
    Session --> Subagent
    Subagent --> Trace
    Subagent --> WriteBoundary
    WriteBoundary --> Tools
    Session --> Transcript
    Transcript --> Runner
    Runner --> Providers
    Runner --> Tools
    Tools --> Resolver
    Resolver --> VisibleTools
    VisibleTools --> Runner
    Tools --> ToolResult
    Tools --> Artifact
    Tools --> DriverResult
    Tools --> CodexAdapter
    CodexAdapter --> CodexThread
    CodexThread --> ToolResult
    Runner --> RuntimeEvent
    Runner --> Delivery
    Runner --> LocalSummary
    Trace --> OtelTrace
    ToolResult --> Evidence
    Artifact --> Evidence
    DriverResult --> Evidence
    RuntimeEvent --> Evidence
    Delivery --> Evidence
    Evidence --> Gates
```

## Core Contracts

- 每个 assistant tool call 必须有 matching tool result，不能把 dangling tool call 送入下一次 provider request。
- Base 与 SubAgentSession 都必须把每次 terminal run 写成标准 `traces.jsonl`；子会话 trace 通过 embedded lifecycle event 保留 `subagent_id`、`parent_session_id` 和 `role_name`，不能只依赖进程内摘要或 `runtime.log`。
- Tool call 必须进入 success、failure、timeout、cancelled 或 blocked 之一，失败要有可观测 `status/error_code`；runner interrupt 时未执行的 pending tool calls 必须生成 `cancelled` ToolResult，而不是从 evidence 中消失。
- Optional OTLP trace export mirrors the runtime span topology but never replaces local evidence. It is explicit opt-in, fail-open, and excludes prompt/tool/file previews plus free-form error text; metrics and logs remain local.
- Release-grade runtime evidence can use `tool_result_contract` to require every tool call fact to carry a canonical terminal `status`, require `error_code` on non-success states, require `blocked_reason` for blocked calls, and check `ok` / retry-budget consistency. Curated `session-log-v2` cases that declare `tool_transcript_completeness` should keep this verifier in their owning `test/contract-smoke` or benchmark source, so promoted session fixtures cannot rely on transcript text alone. This is stricter than `runtime_observability`, which remains a compatibility verifier for failure visibility.
- Provider/model failures that escape the provider call path must become structured runtime evidence: live `AgentSession` writes a `runtime_event:event_type=provider_error` with stable `provider_error.error_code`、`retryable` and session-local budget facts before returning the user-visible fallback. Consecutive same-fingerprint retryable failures must record retry-budget exhaustion and blocked reason; non-retryable provider failures must record immediate blocked evidence. Deterministic failover fixtures must prove provider/endpoint/error_code order and terminal blocked reason until live production-network failover orchestration is stable.
- The fallback turn for a provider/model failure must also carry degraded provider transcript state-boundary evidence. The provider transcript boundary stays digest-ref-only and must include reason/status/fallback-chain/blocked/raw-payload storage facts, so downstream State/Evidence gates can audit degradation without requiring raw provider request or response retention.
- Scripted Runtime Test results must retain every hard verifier declared by their source fixture. Runtime owns structured ToolResult/delivery/artifact facts; generated Test evidence cannot bypass newly added Runtime contracts.
- Top-level `error_code` describes tool execution failure only. If a successful tool result contains domain-level blocked/path/validation evidence, that evidence must stay in the result payload or artifacts; `SessionTurnLogger` must not hoist it into a success ToolResult's top-level `error_code`.
- ToolManager 负责三层工具可见性：base tool 受 role 的 `inheritBaseTools`、allowlist、denylist 控制；role tool 由 role registry 注入；surface tool 只在显式 channel-backed surface 上可见。
- `spawn_subagent` 是 role-aware / no-skill sub-agent dispatch boundary：`role_name` 和 `skill_name` 互斥，但允许二者都不传。只传 `skill_name` 时，子智能体继承父会话当前 role 并预激活该 role 可见 skill；只传 `role_name` 时，有效 role 会在启动前 canonicalize，并用于加载 role prompt、role-local skills 和 role-specific tools，子智能体再通过 `skill` 工具自行选择该 role 的 skill；二者都不传时，子智能体以无预设 skill、无 role dispatch 的后台会话直接按可见工具执行。
- `ToolExecutionContext.subAgentServiceFactory` 是 deterministic eval / runtime harness 的服务注入点，用于给后台子智能体提供 scripted AIService / skill manager；production `spawn_subagent` 不依赖该字段，仍默认创建真实 runtime services。
- `role_name=base/default/none` 表示明确清空 role，并进入 no-skill dispatch；它不再要求调用方提供 `skill_name`。子智能体内部仍隐藏主会话控制面和外发工具，例如 `spawn_subagent`、`check_subagent`、`stop_subagent`、`resume_subagent`、`send_text` 和 `send_file`。`skill` 工具只在有效 role-only dispatch 中开放，用于让目标 role 自选 skill；no-skill dispatch 不暴露 `skill` 工具。
- `src/tools/tool-result.ts` 是 runtime ToolResult canonicalization boundary。ToolManager、AgentToolExecutor、SubAgent forbidden path 和 ConversationRunner retry/cancel path 必须通过 canonical builder/canonicalizer，保证 `status` 必填、`ok` 与 status 一致、non-success 必有 `error_code`、blocked 必有 `blocked_reason`，并且 success 结果不能携带顶层 execution `error_code`。
- 配置 `allowedWriteRoot` 的 SubAgent 必须把显式文件写和 Shell 写都限制在该根目录；Shell 只有在原生写 sandbox 可用时才执行，否则 fail closed。可自行指定另一个 cwd 并产生写入的 role control tools 必须由调用 workflow 隐藏或增加同等 runtime 校验，不能只依赖 prompt。
- `ToolExecutionOutput` 是工具实现返回结构化执行事实的 live 协议。新工具必须通过 `toolSuccess` / `toolFailure` / `toolBlocked` / `toolTimeout` 等共享 builder 返回 `status`、non-success `error_code`、可选 `blocked_reason` / `retryable` / retry budget facts；`toolContent` 只承载给模型看的 payload，不能作为执行状态的唯一来源。字符串前缀分类只保留给 legacy string output 和未迁移工具，并在代码中命名为 legacy path。
- ToolManager 负责把工具执行结果归一为结构化 ToolResult；core file/search/shell/delivery tools 和 subagent/skill control tools 使用显式语义产出 status/error_code，file/delivery tools 还产出 artifact/delivery evidence 和可选 `external_delivery_receipts`；maintained role tools 可通过 `Tool.getArtifactManifest()` 产出 tool-owned `artifact_manifest`，旧 role-layer 输出才从明确的 JSON / `key=value` artifact 字段保守推断 `action=captured` 的 fallback manifest。
- Maintained role tool artifact semantics belong to runtime/test ownership; they must not be stored under `eval/`, which is live agent eval only.
- Successful outbound delivery tools and opt-in channel fallback final replies must expose structured `delivery_evidence`; deterministic eval uses `delivery_evidence_contract` to require text/file delivery type, status, timestamp, preview/name/path evidence and sent file manifest or runtime file artifact evidence instead of accepting prose-only delivery claims. Scripted replay may synthesize those facts from stable `send_text` / `send_file` arguments and results when a suite omits explicit delivery evidence; surface runtime replay may synthesize them from production Feishu sender callbacks and Dashboard/Pet SSE delivery events.
- ToolResult/session logs and surface runtime replay may additionally carry `external_delivery_receipts` for platform-facing acknowledgements. These receipts capture message/file/upload/download ack ids, status, timestamps, platform message/file ids and evidence refs; Feishu runtime file smoke now requires message/upload/file receipts with platform ids, while Dashboard/Pet local SSE receipts use local delivery ids without pretending to be third-party platform ids.
- ToolManager 还负责 role 声明式二段式可见性：`toolVisibility.mode:"all"` 保持兼容；`toolVisibility.mode:"skill_scoped"` 时，未激活 skill 只暴露 `defaultTools`，激活 skill 后只暴露对应 `skillToolsets` / `skillToolsetAliases` 和仍然允许的 surface tools。
- `skill_scoped` role 的 active skill/toolset 是 session-local domain state，可跨用户确认 turn 保留，直到新 skill 激活、会话清空或进程恢复边界；provider prompt 中的 skill system message 仍按 runner transcript 规则管理，不能成为外部持久权限。
- 确认类工具 gate 必须由 runtime 强制执行。配置为 `confirmedToolGate.tools` 的工具在缺少最近、无否定的显式用户确认时不得进入 provider-visible tool set；即使进入可见集或被硬调，执行前也必须验证 tool args 与最近确认 turn 或上一条 assistant 提案存在 payload-level anchor overlap，匹配失败必须返回 `blocked` ToolResult 和 `TOOL_CONFIRMATION_PAYLOAD_MISMATCH`。
- `ConversationRunner` 发给 provider 的工具定义必须使用当前 `ToolExecutionContext` 过滤后的 visible tool set；隐藏工具被硬调时必须返回 forbidden tool result，而不是执行。
- `ConversationRunner` 负责 transcript 合法性，不保存长期 session，也不决定角色配置。
- `AgentSession` 负责 session lifecycle、role/skill 注入、context compression 和 state cleanup，不直接实现平台 API。
- Context compression 默认按长上下文模型口径配置：`DEFAULT_MAX_CONTEXT_TOKENS=258400`，`DEFAULT_COMPACTION_THRESHOLD=0.7`，也就是约 180k tokens 触发自动压缩。`XIAOBA_LLM_MAX_PROMPT_TOKENS` 可覆盖 runner prompt budget，`XIAOBA_CONTEXT_COMPACTION_THRESHOLD` 可覆盖压缩比例；runner 和 `ContextCompressor` 必须使用同一比例，避免过早在较小保护层抢先压缩。
- Provider-visible transcript、trace、durable session 和 visible history 可以内容不同，但必须可关联且不能互相替代；live `AgentSession` trace logs expose `state_boundary` refs for durable session, legacy `working_trace` evidence and provider transcript digest reference, and release-grade state evidence 可用 `state_boundary_contract` + `provider_transcript_normalization` 证明 provider transcript 只是 normalized `sha256` reference，不是 raw messages/tool payloads 或普通路径 ref。Degraded provider transcript evidence must additionally carry structured `degradation_reason` / terminal `status`, `fallback_chain`, `blocked_reason` and explicit false raw-payload storage flags, so provider failures can be audited without raw transcript retention.
- Provider adapter 负责把各自的消息、tool call、usage 和 streaming 协议归一为 runtime 合同；Ollama native adapter 使用 `/api/chat`、NDJSON streaming、默认 `think:false`、`keep_alive`、`num_ctx` 和可选 API key，以支持本地小模型。
- Retry 必须有上限；重复失败后应改变策略或报告 blocked reason。显式 `retryable` 的 ToolResult retry exhausted 后必须进入 `blocked` 终态并记录 `retry_count` / `retry_budget` / `retry_budget_exhausted`；同一 run 内重复出现同名、同参、同错误的不可重试 ToolResult，必须在 bounded failure budget 后由 `ConversationRunner` 收束为 `blocked` ToolResult，并记录 prior failure count、budget exhaustion 和 `blocked_reason`；interrupt/cancel 必须进入 `cancelled` 终态且不可重试。
- SubAgent stop 必须中断 waiting input、role-tool AbortSignal 和 retry backoff，并阻止迟到 callback 进入已关闭的 CLI session；provider HTTP 和通用 Shell 只有在各自 adapter 消费 AbortSignal 后才能声称物理取消，当前仍是明确缺口。
- 外部 browser/GUI driver 只能通过 role-scoped typed tool adapter 进入 Runtime。Adapter 必须使用 fixed binary + `execFile(argv[])`、显式 timeout/AbortSignal、结构化 error code 和不可信内容标记；不得使用 Shell、动态 `npx latest`、MCP sidecar 或 driver 自带 Agent loop 绕过 ToolManager。
- EngineerCat 是外部 coding executor 的唯一例外入口：`codex_run` 必须是 role-scoped Tool，工作目录来自可信 `ToolExecutionContext`，模型只能选择只读/工作区可写和可选 thread resume。适配器必须传递 AbortSignal，失败必须归一为结构化 ToolResult，不得接受模型提供的 cwd、binary path、network 或 approval policy。XiaoBa 不复制 Codex loop，不引入第二套 job manager/supervisor；续接所需 `thread_id` 只由本次 ToolResult 返回给 EngineerCat。
- 物理 GUI 是进程外共享副作用资源。GuiCat mutation 在执行前必须持有全局桌面 lease；timeout 后 outcome 为 uncertain，不能自动重放。Browser session identity 由可信父 session、child session 和 workspace 共同派生，使同一父会话并发 BrowserCat 也使用不同 native session。
- Browser driver 的 HOME、USERPROFILE、XDG、APPDATA、TMP、socket 和 restore state 必须落在 Runtime 私有目录；不能为了 Chrome discovery 暴露真实 HOME。Unix runtime 根使用短原子 `/tmp/xab-*` 目录以满足 macOS Unix socket path limit。

## Data Contracts

Runtime 需要稳定维护这些结构化事实：

- `surface`、`sessionKey`、role、active skills 和 budget。
- context compression budget defaults: max context tokens、compaction threshold、effective trigger token count and environment overrides.
- context compression evidence: source、status、reason、token/message counts、threshold facts、same-session compact-after `snapshot_ref` and matching `snapshot_id`.
- tool layer、visible tool set、role base-tool inheritance policy 和 surface delivery context。
- tool visibility mode、active skill、visible tool names、hidden tool count、confirmed tool gate decision。
- provider request/response 的 token 和 model metadata；debug dump 只能保留结构、长度、sha256 摘要和非敏感元数据，不能持久化 raw prompt/tool arguments/response payload。
- tool call id、tool name、arguments summary、status、error_code、retryable、duration_ms、blocked_reason、retry_count、retry_budget、retry_budget_exhausted。
- ToolExecutionOutput 中的显式 status/error_code/retryable facts，及 legacy string classification 是否只作为兼容兜底。
- artifact manifest 或 delivery evidence，包括 outbound text/file delivery status。
- delivery evidence facts should include delivery type, status, timestamp, optional surface/channel id, bounded text preview, file name/path and delivery error code where applicable.
- role-local artifact manifest should be tool-owned when the role tool knows creation/update semantics; fallback inference must ignore operational paths such as cwd and ids and mark inferred entries as compatibility evidence.
- maintained role tool artifact contract entries must state whether `artifact_manifest` is required or not applicable, so role registry changes cannot silently fall back to prose/log inference.
- runtime event，例如 timeout、interrupt、context compression、fallback delivery、provider_error，包括 provider failure budget / blocked evidence。
- compact snapshots are local after-compaction message snapshots for replay/debug anchoring; they are not raw provider request/response payloads and do not replace curated replay case packets.
- optional observability attributes for session/model/tool/provider/delivery/eval facts; explicitly recorded previews remain local raw evidence.

## Interaction With Other Modules

- 从 `docs/surface/SPEC.md` 接收规范化 user turn 和 callbacks。
- 从 `docs/roles-skills/SPEC.md` 接收 role prompt、role-scoped tools 和 skill policy。
- 向 [`../observability-evidence/SPEC.md`](../observability-evidence/SPEC.md) 输出 session logs、runtime events、artifact evidence、trace projection 和 durable state。
- 由 `test/contract-smoke` 和 `test/scripted-runtime/base-runtime` 分层验证 transcript completeness、failure observability、delivery evidence 和 JSONL compatibility；这些都属于 Test。
