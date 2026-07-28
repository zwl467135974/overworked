---
name: overworked_git_commit
description: Use when generating a git commit message for staged changes in the Overworked repo. Enforces Conventional Commits in Chinese, with scopes matching the three-layer architecture (sensing/engine/rendering/frontend/docs), and a "red-line impact" footer note for changes that touch the design principles or privacy boundary.
---

# Overworked Git Commit 规范

## 功能概述

为 Overworked 仓库的暂存区变更生成规范化的中文提交信息，保持历史清晰、可追溯。基于 Conventional Commits，叠加项目特定的 scope 和"红线影响"标注。

## 标准格式

```
<type>(<scope>): <subject>

<body 可选>

<footer 可选，含红线影响标注>
```

## 类型 (Type)

| type | 说明 | 示例 |
|---|---|---|
| `feat` | 新功能 | `feat(engine): 新增夜班检测` |
| `fix` | 修复 bug | `fix(sensing): 修复 macOS 空闲检测漏判` |
| `docs` | 文档 | `docs: 补充 PRD 第六章 MVP 范围` |
| `style` | 格式 | `style: rustfmt 全量` |
| `refactor` | 重构（不改功能） | `refactor(engine): 抽出 PetState::apply_sample` |
| `perf` | 性能 | `perf(sensing): 采样改 5 秒窗口聚合` |
| `test` | 测试 | `test(engine): 给体力系统加单测` |
| `chore` | 构建/工具 | `chore: 升级 tauri 到 2.x` |
| `build` | 构建系统 | `build: 配置 cargo workspace` |

## 作用域 (Scope) — 对应三层架构

Scope 强制对齐项目结构（见 `overworked_architecture`）：

| scope | 对应 | 典型内容 |
|---|---|---|
| `sensing` | 行为感知层 | 键盘/鼠标/空闲 hook |
| `engine` | 游戏引擎 | 状态机/事件/数值 |
| `rendering` | 渲染桥 + 前端 Canvas | Expression、动画、冒泡 |
| `frontend` | 前端纯展示层 | Canvas 绘制、气泡 DOM |
| `save` | 存档 | SQLite |
| `tauri` | Tauri 配置/窗口 | tauri.conf.json、command 注册 |
| `docs` | 文档 | PRD、AGENTS.md、README |
| `skills` | AI 配置 | .agents/skills/、AGENTS.md |
| 省略 | 跨多个 | 用 `feat: ...` 不带 scope |

## 主题 (Subject)

- **中文**，首字母小写风格（中文无大小写，指不用句首大写英文）
- 祈使语气："新增""修复""优化"，不用过去式"新增了"
- **不超过 50 字符**
- 结尾不加句号

## 红线影响标注（项目特色，重要）

这是 Overworked 特有的：**任何改动如果触碰了设计红线或隐私边界，必须在 footer 标注**，方便后续审计。

| footer 标签 | 含义 |
|---|---|
| `Red-line: 设计红线X` | 触碰了红线 X（1 不爹味/2 不暴露数值/3 不抢焦点/4 本地优先/5 反差是灵魂） |
| `Privacy: 感知层` | 改动了行为感知相关代码（红线 4 命门） |
| `Privacy: 数值边界` | 改动了数值 → 表情的映射（红线 2 命门） |
| `Privacy: 无影响` | （可选）明确说明不碰任何命门 |

**不强制每条都标**，但碰了就要标。reviewer 看到 `Privacy:` 标签会优先重点看。

## 提交信息模板

### 普通功能

```
feat(engine): 新增夜班检测

凌晨 1-5 点且有键盘活动时，状态切到 NightShift：
- 体力消耗 ×1.5
- 时薪 ×2（双倍产能）
- 表情加黑眼圈

Closes #12
```

### 触碰隐私边界（必标）

```
feat(sensing): 新增窗口标题感知

按 PRD 5.3 实现前台窗口分类（coding/browsing/design）。
默认关闭，需用户主动开启。

Privacy: 感知层
Red-line: 设计红线4（本地优先——仅存分类标签，不存原始标题）
```

### 触碰数值边界（必标）

```
refactor(rendering): 体力映射改为区间式

Stamina 70/40/15 三个阈值切 Working/Tired/Exhausted，
替代原来的线性插值。

Privacy: 数值边界（确认未泄露原始数值到前端）
```

### 纯文档

```
docs: 补充 MVP 行为→状态映射表

PRD 3.2 增加"整理窗口→清理工位"一行的 Phase 2 标注。
```

### 修复

```
fix(sensing): 修复 macOS 空闲时长恒为 0

CGEventSource 的 kCGSessionEventTap 误用为 kCGHIDEventTap，
导致 idle 检测失效。

Privacy: 感知层
```

## 分析暂存区的步骤

```bash
git status --short              # 暂存了哪些文件
git diff --cached --stat        # 变更规模
git diff --cached               # 具体内容（判断是否碰红线/隐私）
```

判断流程：
1. 看文件路径 → 定 scope（`sensing/` → `sensing`）
2. 看具体 diff → 是否触碰设计红线或隐私边界 → 决定 footer 标不标
3. 看 diff 规模 → 决定 body 写不写
4. 组织 type + scope + subject + body + footer

## ✅ 推荐做法

1. 一次提交一个逻辑单元（不要把 sensing 和 docs 混在一起）
2. scope 用架构层名，不用模块细名（`engine` 而非 `engine-state`）
3. 碰红线/隐私必标 footer
4. 大型变更写 body，列主要改动点
5. 关联 issue 用 `Closes #N`

## ❌ 避免做法

1. `update`、`fix bug`、`优化` 这种模糊 subject
2. 混合多个不相关改动到一个 commit
3. 忘了标 `Privacy:` 当改动触碰感知层
4. 用过去式"修复了""新增了"
5. subject 超过 50 字符

## 检查清单

- [ ] type 准确（feat/fix/docs/refactor/perf/test/chore/build）
- [ ] scope 对应架构层（sensing/engine/rendering/frontend/save/tauri/docs/skills）
- [ ] subject 中文、祈使、≤50 字符、无句号
- [ ] 改动触碰红线/隐私时，footer 标注了 `Red-line:` 或 `Privacy:`
- [ ] 大型变更有 body 列要点
- [ ] 关联了相关 issue（如有）
