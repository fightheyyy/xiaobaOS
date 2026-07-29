---
name: role-publish
description: "发布 Role 到官方 RoleHub：将 role 代码托管到独立 GitHub 仓库，并通过 fork 向 fightheyyy/XiaoBa-RoleHub 提交 registry.json 增量 PR。"
invocable: user
autoInvocable: false
argument-hint: "<role名称>"
max-turns: 20
---

# EvolutionCat Role Publish

将本地已有的 role 发布到 XiaoBa 官方 RoleHub，让 XiaoBa 用户可以发现和安装角色。

## 发布模型

官方 RoleHub 仓库：

```text
https://github.com/fightheyyy/XiaoBa-RoleHub
```

RoleHub 只维护轻量索引，不托管 role 源码，也不托管桌宠 spritesheet。Role 源码必须放在独立公开 GitHub 仓库。仓库名不要求固定格式，例如：

```text
https://github.com/<user>/xiaoba-role-<name>
https://github.com/<user>/<custom-role-repo>
```

RoleHub 发布规则：

- 只修改 `registry.json`。
- 只新增一个 role registry 条目，除非用户明确要求修正已存在条目。
- 不复制 `roles/<name>` 到 RoleHub 仓库。
- 不复制 `pets/<pet-id>` 或 spritesheet 到 RoleHub 仓库；自定义桌宠资源应该放在独立 role 仓库中。
- 需要 fork `fightheyyy/XiaoBa-RoleHub`，但 fork 中也只改 `registry.json`。
- 不重排、删除、批量格式化已有 registry 条目。
- 提交前必须检查 `git diff -- registry.json`，确认 diff 只包含目标 role 的索引增量。
- 通过 fork 分支向官方仓提交 PR；`fightheyyy` 维护者如明确要求，也可以按仓库 ruleset bypass 直接推 `main`。
- 如果 role 没有上传桌宠资源，registry 不写 `pet` 字段，XiaoBa runtime 使用默认 `xiaoba` runtimepet。

## 执行流程

### Step 1：确认要发布的 role

用户提供 role 名称（即 `$ARGUMENTS`），你需要：

1. 检查 `roles/$ARGUMENTS/role.json` 是否存在；如果不存在，按 alias/normalized name 查找 `roles/<role-name>/role.json`
2. 读取 `role.json`，提取 `name`、`displayName`、`description`、`promptFile`、`aliases` 和 `metadata.petId` 等信息。只发布已经由共享 Test + Eval 控制 DAG 激活到生产目录的资产；隔离 Candidate 不可直接发布
3. 检查 `promptFile` 指向的 prompt 是否存在，优先检查 `roles/<role-name>/prompts/<promptFile>`，再检查 `roles/<role-name>/<promptFile>`
4. 如果缺少 category，询问用户选择：核心、工具、效率、科研、运维、其他
5. 如果 `metadata.petId` 存在，检查本地是否有匹配桌宠资源，例如 `dashboard/pets/<petId>/pet.json`、`$XIAOBA_PETS_DIR/<petId>/pet.json` 或用户提供的 pet 目录
6. 确认用户是否要把自定义 pet 一起放进独立 role 仓库；如果不上传，registry 省略 `pet` 字段并说明会回退到默认 `xiaoba` runtimepet
7. 确认 role 是否已经有独立公开 GitHub 仓库
8. 获取或确认独立 role 仓库 URL
9. 向用户确认发布信息

发布信息至少包含：

```json
{
  "name": "<name>",
  "displayName": "<displayName>",
  "description": "<desc>",
  "category": "<cat>",
  "recommended": false,
  "repo": "<confirmed-role-repo-url>",
  "rolePath": "."
}
```

如果用户确认上传桌宠资源，还应包含：

```json
{
  "pet": {
    "id": "<petId>",
    "repoPath": "pets/<petId>"
  }
}
```

### Step 2：准备独立 role 仓库

如果 role 已经有公开仓库，使用现有 repo URL。

如果还没有公开仓库，告诉用户先在 GitHub 创建一个公开仓库，建议命名：

```text
xiaoba-role-<name>
```

然后把本地 `roles/<name>` 的内容推送到这个独立仓库。RoleHub 的 `repo` 字段必须指向这个独立仓库，而不是 RoleHub 仓库里的子目录。

独立 role 仓库至少应该包含：

- `role.json`
- `prompts/<promptFile>` 或 `role.json` 中实际引用的 prompt 文件
- role 专属 `skills/` 可选运行时资产；当前 XiaoBa 仓库内不要创建 role-local README/SPEC/PLAN

如果用户要发布自定义桌宠资源，独立 role 仓库还应该包含：

- `pets/<petId>/pet.json`
- `pets/<petId>/<spritesheet>`，通常是 `spritesheet.webp`

桌宠发布约束：

- `role.json.metadata.petId`、registry 的 `pet.id`、`pets/<petId>/pet.json` 的 `id` 应一致。
- `pet.json.spritesheetPath` 必须指向同一 pet 目录内的文件。
- 如果用户不上传 pet，不要为了默认资源复制 `xiaoba` pet；省略 registry 的 `pet` 字段即可。

### Step 3：Fork 当前官方 RoleHub

默认发布方式是 fork RoleHub，再向官方仓提交 registry-only PR。

优先用 `gh` 获取当前 GitHub 登录名，并创建 fork：

```json
{"command":"login=$(gh api user --jq '.login') && echo \"$login\" && if [ \"$login\" = \"fightheyyy\" ]; then echo 'fightheyyy maintainer account: switch to contributor account for fork flow, or use maintainer shortcut only when explicitly requested'; else gh repo view \"$login/XiaoBa-RoleHub\" >/dev/null 2>&1 || gh repo fork fightheyyy/XiaoBa-RoleHub --clone=false; fi","description":"确认 GitHub 身份并 fork RoleHub"}
```

如果当前登录账号是 `fightheyyy`，不要把官方仓当作 fork。此时应该切换到 contributor 账号走 fork PR，或在用户明确要求时使用维护者快捷方式直接发布。

如果没有 `gh`，告诉用户在网页上手动 fork：

1. 打开 https://github.com/fightheyyy/XiaoBa-RoleHub
2. 点击右上角 **Fork**
3. Fork 到自己的 GitHub 账号
4. 告知 fork 地址，例如 `https://github.com/<user>/XiaoBa-RoleHub`

### Step 4：Clone fork 并从官方 main 新建发布分支

1. 创建临时目录并 clone fork：
```json
{"command":"mkdir -p /tmp/xiaoba-role-publish && cd /tmp/xiaoba-role-publish && rm -rf XiaoBa-RoleHub && git clone https://github.com/<user>/XiaoBa-RoleHub.git","description":"Clone RoleHub fork"}
```

2. 添加官方 upstream，并从官方 main 新建增量分支：
```json
{"command":"cd /tmp/xiaoba-role-publish/XiaoBa-RoleHub && git remote add upstream https://github.com/fightheyyy/XiaoBa-RoleHub.git 2>/dev/null || true && git fetch upstream main && git checkout -B add-role-<name> upstream/main","description":"从官方 main 新建发布分支"}
```

3. 检查 registry：
```json
{"command":"cd /tmp/xiaoba-role-publish/XiaoBa-RoleHub && cat registry.json","description":"查看 RoleHub registry"}
```

### Step 5：增量更新 registry.json

只允许编辑 `registry.json`。不要复制 role 文件或 pet 文件到 RoleHub。

用脚本安全追加 JSON 条目：
```json
{"command":"cd /tmp/xiaoba-role-publish/XiaoBa-RoleHub && python3 -c \"\nimport json\nfrom pathlib import Path\npath=Path('registry.json')\ndata=json.loads(path.read_text(encoding='utf-8'))\nname='<name>'\nrepo='<confirmed-role-repo-url>'\nif any(item.get('name') == name for item in data):\n    raise SystemExit(f'role already exists in registry: {name}')\nentry={'name':name,'displayName':'<displayName>','description':'<desc>','category':'<cat>','recommended':False,'repo':repo,'rolePath':'.'}\n# 如果用户确认上传自定义 pet，再启用下一行并替换 petId：\n# entry['pet']={'id':'<petId>','repoPath':'pets/<petId>'}\ndata.append(entry)\npath.write_text(json.dumps(data,indent=2,ensure_ascii=False)+'\\n',encoding='utf-8')\nprint('registry.json updated')\n\"","description":"增量更新 registry.json"}
```

如果 `git diff -- registry.json` 显示已有条目被重排、删除或批量格式化，必须恢复后重新做最小增量编辑。

### Step 6：验证只包含 registry.json 增量

```json
{"command":"cd /tmp/xiaoba-role-publish/XiaoBa-RoleHub && git diff -- registry.json && git status --short","description":"检查 registry 增量 diff"}
```

```json
{"command":"cd /tmp/xiaoba-role-publish/XiaoBa-RoleHub && test \"$(git status --porcelain --untracked-files=all)\" = \" M registry.json\" && echo 'OK: only registry.json changed'","description":"确认只修改 registry.json"}
```

### Step 7：提交 registry 增量

```json
{"command":"cd /tmp/xiaoba-role-publish/XiaoBa-RoleHub && git add registry.json && git status --short","description":"只暂存 registry.json"}
```

```json
{"command":"cd /tmp/xiaoba-role-publish/XiaoBa-RoleHub && git commit -m 'Add role: <name>'","description":"提交 registry 增量"}
```

### Step 8：发布到 fork 并创建 PR

推送到 fork 的发布分支：

```json
{"command":"cd /tmp/xiaoba-role-publish/XiaoBa-RoleHub && git push -u origin add-role-<name>","description":"推送 fork 发布分支"}
```

向官方 RoleHub 创建 registry-only PR：

```json
{"command":"cd /tmp/xiaoba-role-publish/XiaoBa-RoleHub && gh pr create --repo fightheyyy/XiaoBa-RoleHub --base main --head <user>:add-role-<name> --title 'Add role: <name>' --body '## New Role: <name>\\n\\n<description>\\n\\nRegistry-only incremental PR.'","description":"创建 RoleHub registry-only PR"}
```

维护者快捷方式：如果当前账号是 `fightheyyy`，且用户明确要求直接发布，可以跳过 fork，clone 官方仓后 fast-forward 到 `main` 并直接推送：

```json
{"command":"cd /tmp/xiaoba-role-publish/XiaoBa-RoleHub && git checkout main && git merge --ff-only add-role-<name> && git push origin main","description":"fightheyyy 维护者直接推送 main"}
```

### Step 9：清理

```json
{"command":"rm -rf /tmp/xiaoba-role-publish","description":"清理临时目录"}
```

## PR 验收标准

- PR base：`fightheyyy/XiaoBa-RoleHub:main`
- PR changed files：只有 `registry.json`
- `registry.json` 是合法 JSON array
- 新条目字段完整：`name`、`displayName`、`description`、`category`、`recommended`、`repo`
- `repo` 指向独立公开 GitHub 仓库
- 独立 role 仓库包含 `role.json`
- 独立 role 仓库包含 `role.json` 引用的 prompt 文件
- 如果 registry 包含 `pet`，独立 role 仓库包含 `pet.repoPath/pet.json` 和对应 spritesheet
- 如果 registry 不包含 `pet`，明确接受默认 `xiaoba` runtimepet 回退
- RoleHub fork 里没有 role 源码，只包含 `registry.json` 增量
- 没有删除、重排、批量格式化已有 registry 条目

## 注意事项

- **GitHub 权限**：普通用户只需要能 fork 并向自己的 fork 推送；不需要官方仓写权限
- **Windows**：临时目录改用 `%TEMP%`
- **如果推送失败**：先检查 `gh auth status`、fork 地址和 `origin` 是否指向自己的 fork
- **Role 依赖**：提醒用户在独立 role 仓库的 README 里说明依赖、适用场景和启用方式
- **Pet 资源**：自定义 pet 是可选增强，不是发布阻断项；不上传时不要复制默认 `xiaoba` runtimepet
- **Registry-only**：RoleHub 改动不应该包含 role 源码、README 大改或无关格式化

## 简化流程总结

```text
准备独立 role 仓库 -> fork RoleHub -> clone fork -> 从官方 main 新建分支 -> 只增量更新 registry.json -> push fork 分支 -> 创建 registry-only PR
```

这样不需要官方仓写权限，也能保持 RoleHub registry PR 清晰、可审。
