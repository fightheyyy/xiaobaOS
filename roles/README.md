# XiaoBa Roles

XiaoBa 只有一个面向用户的 Base Main Agent。Role 是 Base 派遣的专业 Subagent 配置，全部复用同一套 XiaoBa Agent Runtime。

架构和进度统一维护在 [`docs/roles-skills/SPEC.md`](../docs/roles-skills/SPEC.md) 与 [`docs/roles-skills/PLAN.md`](../docs/roles-skills/PLAN.md)。

## 默认八个角色：4 个功能型 + 4 个内部持续改进

八个 Role 全部复用同一套 XiaoBa Agent Runtime。分组表达的是责任和启动方式，不是两套控制平面。

### 4 个功能型 Role

| Role | 责任 | 不负责 |
| --- | --- | --- |
| `engineer-cat` | 代码与工程环境接管；实质性编码可经窄适配器委托 Codex | 浏览器/桌面专属操作、Codex job 调度系统 |
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

EngineerCat 的 `codex_run` 复用官方 [`@openai/codex-sdk`](https://www.npmjs.com/package/@openai/codex-sdk)。依赖中已包含当前平台 Codex 可执行文件；首次使用前运行 `codex login`，或配置 `CODEX_API_KEY`。需要使用另一个固定可执行文件时，由运维环境设置 `XIAOBA_CODEX_EXE`；该路径不会暴露给模型参数。Codex 默认禁用 web/network 与已配置 MCP server，并在当前工作区的只读或可写沙箱中执行。

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

### 文件记忆维护与统一夜间调度

Base 可以在发现稳定偏好、长期事实、纠正或可复用经验时，主动派给
EvolutionCat；无需用户每次说“记住”。EvolutionCat 的 `remember` 支持写入、
替换、遗忘和归档；推断记录可带 `confidence=medium` 和来源、时间、范围。
失效记录保留在本会话 `ARCHIVE.md`，按需读取，稳定事实不因年龄自动删除。

所有夜间工作共用一个工作区 Scheduler，经 Event 分发给各自消费者：

```bash
xiaoba schedule install --jobs memory --hour 3 --minute 17 --timezone Asia/Shanghai
xiaoba schedule status
xiaoba schedule tick
xiaoba schedule remove --jobs memory
```

macOS/Linux 都可以使用 `--jobs memory,evolution` 启用两项工作；自动自进化需要
可用的统一 SDK 沙箱。每个任务可以通过兼容
命令单独修改时间；两项任务仍只安装一个 `schedule tick` cron：

```bash
xiaoba memory schedule install --hour 3 --minute 17 --timezone Asia/Shanghai
xiaoba evolution schedule install --hour 4 --minute 0 --timezone Asia/Shanghai
```

旧 schedule 命令仍可使用，安装/移除时会迁移该工作区的旧 cron 并保留其他
任务；只升级代码不会自动修改主机 cron。主机需要 cron 正常运行，并且该
进程可读取 AI 配置。`schedule status` 的 `migrationRequired` 表示需要迁移。

手动执行或重试：`xiaoba memory maintain` / `xiaoba evolution sleep`。两者
同样经 Event 接收。每日失败或中断事件不会被下一分钟的 tick 自动重放，
且一个任务失败不会阻塞另一个任务。记忆处理失败不推进对应会话的增量
进度；已有历史会在对应会话下次记录可见消息后进入维护范围。

### 会话定时提醒与主动检查

直接对 Base 说“明天下午三点提醒我带护照”，它会调用 `schedule_reminder` 持久化一次性提醒，成功后才确认；也可说“把这个提醒改到四点”或“取消”，Base 会先查询本会话记录再操作。时间默认中国时区，有歧义时会澄清。

Agent 判断某件事需要稍后关注时，也能创建 `check`。到点会恢复原 session，结合当前记忆和上下文决定继续工作、发送消息或保持安静。它不会把历史检查当作用户的新授权；事情结束后停止跟进。

飞书、微信、Pet 服务在线时自动扫描到期记录，无需为每条提醒安装 cron；Pet 消息进入原聊天历史，可在界面重连后查看。入口离线或 session 忙时保留 pending，恢复后补触发；CLI 退出后要重开同一 session 才能触发。失败或中断记录保留用于检查，避免盲目重复发送；可显式把失败提醒改为新的未来时间。当前不支持重复周期、跨入口转发或通知升级策略。


## Agent 自有应用连接

Gmail、Notion、GitHub 是 Base 可调用的原生 Connector，直接使用官方 API；Feishu 仍走 SecretaryCat 的现有官方 CLI 适配。应用账号属于 Agent，session 只标识和 Agent 对话的人/群，并保存各自交流上下文。

在工作区 `.env` 或启动进程的环境中配置 `.env.example` 中的 `XIAOBA_GITHUB_TOKEN`、`XIAOBA_NOTION_TOKEN`，或 Gmail 的 `XIAOBA_GMAIL_CLIENT_ID` / `XIAOBA_GMAIL_CLIENT_SECRET` / `XIAOBA_GMAIL_REFRESH_TOKEN`。不要在对话里提供凭据。Gmail 需启用 Gmail API，通过 Google OAuth 授权 Agent 邮箱并取得 offline refresh token；也可以在 Dashboard 的“应用连接”页面完成 Google OAuth 授权。

- GitHub 建议使用限定仓库的 fine-grained token。仓库内容读取需要 Contents read，Issue 写入需要 Issues write，PR 创建需要 Pull requests write，Actions 列表需要 Actions read。
- Notion 使用 integration token，并在 Notion 中将目标页面/数据源连接到该 integration；按需启用读取、插入、更新权限。数据库元数据和 data source 查询是不同操作。
- Gmail 仅查看邮箱可用 `gmail.readonly`；发送用 `gmail.send`；草稿管理/发送用 `gmail.compose`；标签修改用 `gmail.modify`。按计划启用的操作选择 scopes；refresh token 只能继承实际授权的 scopes，Connector 不自动申请或扩权。Google Testing 状态的外部 OAuth 应用还需注意 refresh token 有效期。

```bash
xiaoba connector list
xiaoba connector describe github
xiaoba connector configure github
xiaoba connector configure notion
xiaoba connector configure gmail
xiaoba connector verify github
xiaoba connector verify notion
xiaoba connector verify gmail
# 可选择其他环境变量名称，参数不是 token 值：
xiaoba connector configure github --token-env MY_AGENT_GITHUB_TOKEN
xiaoba connector configure gmail --disable
```

连接成功后，CLI、Feishu、Weixin、Pet 的所有主会话默认可调用全部连接器操作，不需要逐个配置权限。旧的 session 操作授权不再生效；子 Agent 仍遵循现有 Role 工具边界。

支持 GitHub 仓库/Issue/PR/文件/Actions 读取与 Issue/PR 创建更新；Notion 搜索、页面、区块、数据库元数据、数据源查询和页面/区块写入；Gmail 搜索、正文/线程读取、标签、草稿及发送。分页需要显式使用返回游标；Gmail 附件目前只返回元数据。所有写工具先展示完整参数提案、下一条用户确认后才执行，写入失败或超时不自动重试。

配置只将环境变量名称、启用状态写入 `data/connectors/config.json`。这层权限限制 Connector 调用；现有通用 Shell/文件能力仍在同一主机运行，不能当成隔离恶意租户的系统沙箱。Dashboard 授权管理页面已实现；应用事件订阅以及子 Agent 的受限委派尚未实现。


Dashboard 左侧 **应用连接 / Connectors** 只保留 Gmail、Notion、GitHub 三个授权入口，复用现有卡片与弹窗样式。点击“连接”填写 GitHub/Notion Token，保存后自动验证账号；Gmail 点击“通过 Google 授权”，首次需在弹窗填写 Google OAuth 客户端配置。默认使用覆盖现有 Gmail 功能的 gmail.modify，不需要勾选权限。网页 OAuth 客户端需在 Google Console 登记弹窗显示的完整回调地址（含端口），启用 Gmail API 并配置 consent screen/test users。授权后自动验证邮箱，也可以重新授权或断开连接。

凭据只写入 Agent 的 `data/connectors/credentials.json`，不回显、不保存到浏览器或进入聊天；本地文件权限收窄，但不是加密密钥库。保存后优先使用这份凭据，当前和新启动的 runtime 都会读取；没有本地记录时继续使用原环境变量配置。更换 Google OAuth 客户端后需重新授权。断开连接会停用连接并移除本地凭据，保留环境变量和 provider 侧授权；不会偷偷用环境变量重新连接。撤销 Google 的服务端授权可在 Google Account 中操作。

管理页仅通过 `127.0.0.1` / `localhost` / `::1` 的本机地址开放；即使 Dashboard 监听所有网卡，连接管理 API 也拒绝非本机访问及跨站写入。远程带认证的管理入口尚未实现。飞书不在这三个授权入口中；SecretaryCat 的 `lark-cli` profile 授权仍由官方 CLI 管理。


Electron 桌面客户端会在系统浏览器打开 Google 授权；完成后返回应用自动刷新连接状态。浏览器版 Dashboard 会直接跳转并在授权回调后返回应用连接页。


### 统一执行沙箱

Shell、文件工具、受限子任务、Arena 和 Evolution 的进程隔离统一使用本地开源 `@anthropic-ai/sandbox-runtime`，无需购买沙箱服务。需要 Node.js >=22.12；Linux 安装 Bubblewrap、socat、ripgrep，并需要可用的 user namespace；macOS 使用 SDK 的 Seatbelt。先执行 `xiaoba sandbox check` 验证实际可用性。Windows 接入尚未验收，受限执行会返回 blocked。

工作区可读写，运行依赖只读，HOME/TMP 私有；.env、Agent Connector 凭据和其他 session 的私人记忆不可读。当前会话记忆与共享项目索引由 Runtime 明确开放读取；remember 与 Connector 仍走原有可信工具接口。普通 Shell 默认只允许 npm/GitHub 的预设域名，离线候选工作不开放任意网络。写到工作目录外会被阻止，SDK 缺依赖时不会退回宿主裸执行。Codex 自身的 SDK 沙箱、Browser/GUI/飞书能力接口继续保留各自边界。
