# Skills 目录说明

## 统一的 Skill 管理

Base 默认不再常驻任何 Skill。项目根目录 `skills/` 只用于用户显式安装的独立 Skill 和 Arena subject；默认角色自己的工作方法放在 `roles/<role>/skills/`。

`remember` 已改为 EvolutionCat 的确定性 runtime tool，不是 Skill。`self-evolution`、`role-publish`、`skill-publish` 位于 `roles/evolution-cat/skills/`，只由 EvolutionCat 使用。

如果使用角色模式（例如 `xiaoba --role inspector-cat`），运行时加载该角色的 role-local Skills，并按 `role.json` 决定是否加载用户显式安装的独立 Skills。

发行目录里能被解析的 Skill package 就是当前可用 Skill。Runtime 不维护 `candidate / active / blocked` 状态，也不读取旧 `status` frontmatter；需要停用时直接卸载 package。

Evolution Candidate 只存在于一次 run 的隔离 `output/evolution/**/candidates/` 目录，通过 shared Test + Eval 后才原子替换发行目录中的 package。Dashboard 只展示、安装和删除当前 package，不负责晋升。

## 目录结构

```
skills/
└── <explicitly-installed-skill>/
    └── SKILL.md

roles/evolution-cat/skills/
├── self-evolution/
├── role-publish/
└── skill-publish/
```

## Skill 命令

### 查看所有可用的 Skills

```bash
xiaoba skill list
```

### 从 GitHub 安装 Skill

```bash
xiaoba skill install-github owner/repo
```

示例：
```bash
xiaoba skill install-github obra/superpowers
```

Skill 会被克隆到 `skills/` 目录并立即作为用户显式安装资产可用；它不会因此变成默认发行的 Base Skill。非默认 Skill 默认不进入 Git 跟踪。

### 查看 Skill 详情

```bash
xiaoba skill info <skill-name>
```

### 删除 Skill

```bash
xiaoba skill remove <skill-name>
```

强制删除（不询问）：
```bash
xiaoba skill remove <skill-name> -f
```

## 手动添加 Skill

直接在基础 `skills/` 目录或角色目录 `roles/<role>/skills/` 下创建文件夹，每个 Skill 包含一个 `SKILL.md` 文件：

```
skills/
└── my-custom-skill/
    └── SKILL.md
```

### SKILL.md 格式

```markdown
---
name: my-custom-skill
description: 我的自定义 Skill
invocable: user
---

# Skill 内容

在这里编写 Skill 的具体指令...
```

## 注意事项

- ✅ 显式安装的独立 Skills 在 `skills/`，角色专属 Skills 在 `roles/<role>/skills/`
- ✅ Base 默认 Skill 数量为 0
- ✅ 每个 Skill 一个独立文件夹
- ✅ 必须包含 `SKILL.md` 文件
- ✅ 支持从 GitHub 直接安装
- ❌ 不再支持多级目录（npm、用户级、项目级等复杂结构）

## 迁移现有 Skills

如果你之前的 Skills 在其他位置（如 `.xiaoba/skills/` 或 `~/.xiaoba/skills/`），请手动移动到 `skills/` 目录：

```bash
# 示例：迁移 .xiaoba/skills/ 中的 Skills
mv .xiaoba/skills/* skills/
```
