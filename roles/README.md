# XiaoBa Roles

XiaoBa 只有一个面向用户的 Base Main Agent。Role 是 Base 派遣的专业 Subagent 配置，全部复用同一套 XiaoBa Agent Runtime。

架构和进度统一维护在 [`docs/roles-skills/SPEC.md`](../docs/roles-skills/SPEC.md) 与 [`docs/roles-skills/PLAN.md`](../docs/roles-skills/PLAN.md)。

## 默认八个角色：4 个功能型 + 4 个内部持续改进

八个 Role 全部复用同一套 XiaoBa Agent Runtime。分组表达的是责任和启动方式，不是两套控制平面。

### 4 个功能型 Role

| Role | 责任 | 不负责 |
| --- | --- | --- |
| `engineer-cat` | 代码与工程环境接管、实现返工 | 浏览器/桌面专属操作 |
| `browser-cat` | 浏览器接管和页面证据验证 | 桌面 GUI、任意 Shell |
| `gui-cat` | macOS 桌面 GUI 接管和操作证据 | 浏览器专属流程、任意 Shell |
| `secretary-cat` | 飞书日历、消息、邮件、任务、文档和协同工作流；可用 `feishu-cat` / `FeishuCat` 别名 | 重写飞书 API/CLI、绕过确认直接执行后果动作 |

### 4 个内部持续改进 Role

| Role | 责任 | 不负责 |
| --- | --- | --- |
| `user-cat` | 像普通用户一样与 Subject 互动；缺省时生成 Scenario | Oracle、证据判断、修复、裁决 |
| `inspector-cat` | 把 Trace 变成 0..n 有证据的 Finding + Case | 实现、路由、裁决 |
| `evolution-cat` | 确定性长期记忆和 Role/Skill/Memory Candidate 生成 | 代码、Eval、自我激活、跨角色调度 |
| `reviewer-cat` | 共享 Agentic Judge；依据 Case、Oracle 和 Trace 返回结构化 decision | Replay 执行、实现、后续动作 |

内部四个 Role 按 workflow 场景启动，并不构成每次全部执行的线性链。

稳定协作关系：

```text
Scenario -> UserCat <-> Subject -> Trace -> InspectorCat -> Finding + Case -> Eval
Trace / Case -> EngineerCat or EvolutionCat -> Candidate -> Test + Eval -> new Sessions
```

## 使用

```bash
xiaoba role list
xiaoba role info engineer-cat
xiaoba --role engineer-cat
xiaoba --role browser-cat
xiaoba --role gui-cat
xiaoba --role feishu-cat
xiaoba --role evolution-cat
xiaoba chat --role user-cat -m "像普通用户一样试用这个功能"
xiaoba evolution sleep --harvest-only
xiaoba evolution schedule install  # macOS only
```

内置自动 schedule 当前仅支持 macOS 的每日 cron；其他平台可显式运行 `xiaoba evolution sleep`。

SecretaryCat 复用[官方 larksuite/cli](https://github.com/larksuite/cli)执行飞书能力。XiaoBa 只在它上面增加角色派遣、领域工具收窄、后果动作确认、交付和 evidence；使用前需在本机安装并配置官方 `lark-cli`。

Base 派遣跨角色工作时使用 `role_name`，目标角色自行选择其可见 Skill。`base`、`default`、`none` 表示不激活角色。

`xiaoba evolution sleep` 与 schedule 已进入轻量 Evolution control，并复用 shared Test、shared Eval 和 next-Session activation。

## Role 包结构

```text
roles/<role-name>/
  role.json
  prompts/<prompt-file>.md
  skills/<skill-name>/SKILL.md   # optional
```

- `role.json`：名称、描述、prompt、skill/tool policy 和确认 gate。
- 发行目录中的 Role package 都可被 Runtime 发现；Role Candidate 只存在于一次 Evolution run 的隔离目录。
- `prompts/**`：运行时角色指令，不是用户文档。
- `skills/**/SKILL.md`：角色工作方法，不拥有独立 Agent loop。
- 原生角色工具位于 `src/roles/**`，必须经过共享 ToolManager。

非默认角色通过显式安装或本地资产进入，不自动加入 GitHub 默认跟踪和 Electron 默认包。
