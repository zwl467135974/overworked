# Overworked 开发规则

> 一只住在屏幕角落的像素打工仔。你用电脑，它就在打工。
> 你加班它受伤，你摸鱼它瘫倒，你卷它就卷。你以为在养宠物，其实在养你自己的镜子。

本文件是 Overworked 项目的 AI 协作总入口。详细规范在 `.agents/skills/` 下的技能包里，本文件负责**指路 + 灵魂前置 + 提交前检查清单**。

完整产品定义见 [`docs/PRD.md`](docs/PRD.md)。

---

## 技术栈

- **Tauri**（桌面端，轻量常驻）
- **Rust**（行为感知 + 游戏逻辑）
- **Canvas**（像素动画，32×32 或 48×48）
- **SQLite**（本地存档，单文件）
- **rdev / winapi**（行为感知，跨平台 hook）

---

## 设计红线（项目灵魂，任何迭代不可违背）

**这五条是 Overworked 的立身之本，所有功能决策必须先过这道关。** 详见 `overworked_design_principles`。

1. **不爹味** — 绝不主动提醒/教育用户。它只反应，不教育。
2. **不暴露数值** — 体力/时薪/心情/存款绝不传给前端，状态靠表情和动画传达。
3. **不抢焦点** — 永远待在角落，绝不弹窗、绝不遮挡工作区。
4. **本地优先** — 零账号、零联网、零隐私焦虑。感知层只记频率不记内容、不截屏、不上传。
5. **反差是灵魂** — 可爱像素 × 社畜惨状的错位不能丢。任何让它"太正经"的设计都要否决。

---

## 项目技能包（Skills）

位于 `.agents/skills/`。AI 助手根据上下文自动识别并加载相关技能包。

### ⭐ 灵魂与命门（最高优先级，碰产品必先加载）

| # | 技能包 | 守护什么 | 触发条件 |
|---|---|---|---|
| 1 | **`overworked_design_principles`** ⭐ | 五条设计红线 + 功能决策过滤器 | 任何功能设计、UI/文案、产品行为改动、代码审查时 |
| 2 | **`overworked_behavior_sensing`** 🔒 | 行为感知实现 + **隐私三条红线**（A 不记内容/B 不截屏/C 不上传） | 碰键盘/鼠标 hook、空闲检测、窗口标题、`rdev`/`winapi` 时 |

### 核心实现

| # | 技能包 | 守护什么 | 触发条件 |
|---|---|---|---|
| 3 | `overworked_architecture` | Tauri 三层架构 + 前后端 command/event 边界 + 性能预算 | 搭工程、新增模块、写 Tauri command/emit 时 |
| 4 | `overworked_game_loop` | 核心循环 + 四属性状态机 + 行为映射 + 冒泡文案 | 改数值/事件/状态、写吐槽文案时 |

### 工程规范

| # | 技能包 | 守护什么 | 触发条件 |
|---|---|---|---|
| 5 | `overworked_rust_style` | Rust 命名/模块/所有权/错误处理 | 写或审 `.rs` 代码时 |
| 6 | `overworked_git_commit` | Conventional Commits + 红线影响标注 | 生成 commit 信息时 |

### 技能包使用说明

1. **灵魂前置**：碰产品行为的功能，**先** load `overworked_design_principles` 过五条红线，再谈实现
2. **自动识别**：AI 助手根据用户请求和代码上下文自动识别需要的技能包
3. **按需加载**：优先加载元数据，需要时再加载完整内容
4. **引用规范**：`.agents/skills/overworked_xxx/SKILL.md`

---

## 项目结构（待建工程的约定）

与 `overworked_architecture` 对齐：

```
overworked/
├── src-tauri/                      Tauri 主进程（Rust）
│   ├── src/
│   │   ├── main.rs                 入口：注册 command、启动 sensing tick
│   │   ├── sensing/                层 1：行为感知（产出 BehaviorSample）
│   │   ├── engine/                 层 2：游戏引擎（状态机/事件/存档）
│   │   └── rendering_bridge/       层 3：数值→表情 + Tauri emit
│   ├── Cargo.toml
│   └── tauri.conf.json             透明/置顶/无边框/不抢焦点
├── src/                            前端（Canvas 动画 / 冒泡）
├── docs/PRD.md                     产品需求文档
├── .agents/skills/                 AI 技能包
└── AGENTS.md                       本文件
```

**依赖方向（单向）**：`sensing → engine → rendering_bridge → frontend`

---

## 编码前置检查清单（Pre-Delivery Checklist）

每次新增功能或改动用户可见行为时，**必须**逐项确认：

### 灵魂层（碰产品必过）

- [ ] **过五条红线**：改动是否违背设计红线？（先 load `overworked_design_principles`）
- [ ] **不爹味**：没有主动提醒/教育用户的文案或弹窗
- [ ] **反差守住**：改动没有让小生物变得"太正经"

### 数值边界（红线 2 的命门）

- [ ] **数值不外泄**：体力/时薪/心情/存款没有通过任何 command 暴露给前端
- [ ] **表情映射在 Rust 侧**：数值 → Expression 的翻译在 `rendering_bridge` 完成
- [ ] **前端只持表情**：前端 state 只存 `Expression`，不存数字

### 隐私边界（红线 4 的命门）

- [ ] **感知代码过隐私红线**：只记频率不记内容、不截屏、不上传（load `overworked_behavior_sensing`）
- [ ] **低频采样**：是 5 秒窗口聚合，不是事件驱动
- [ ] **窗口标题默认关闭**：若新增，确认默认 off 且只存分类标签

### 焦点与交互（红线 3）

- [ ] **不抢焦点**：新 UI 不获取输入焦点、不置顶遮挡
- [ ] **冒泡克制**：≤3 秒自动消失
- [ ] **右键菜单极简**：没有偷偷加设置面板

### 性能（PRD 5.4）

- [ ] **内存** < 80MB
- [ ] **CPU** 空闲 < 1%、动画 < 3%
- [ ] **行为日志** 不无限增长（定期裁剪/聚合）

### 工程

- [ ] **分层正确**：新代码放对层（感知/引擎/桥），依赖单向
- [ ] **跨平台**：用 `cfg(target_os)` + trait 抽象，不写死单平台
- [ ] **不 panic**：业务路径无 `unwrap()`/`expect()`
- [ ] **编译通过**：`cargo check` 通过
- [ ] **commit 规范**：碰红线/隐私的改动标注了 `Red-line:` / `Privacy:` footer

---

## Git Commit 规范

遵循 `overworked_git_commit`：Conventional Commits + 中文 + 架构层 scope + **红线影响标注**。

```
feat(engine): 新增夜班检测

凌晨 1-5 点且有键盘活动时切 NightShift。

Privacy: 无影响
```

触碰感知层或数值边界时，footer 必标 `Privacy:` 或 `Red-line:`。

---

## 上下文管理（长会话）

- **阶段性 checkpoint**：每完成一个独立任务并提交后，做 3 行总结（做了什么/改了哪些文件/下一步），便于上下文压缩后恢复
- **新会话承接**：大型任务完成后，建议新开 ZCode 会话，保持上下文精简
- **当前进度快查**：`git log --oneline -10` 快速恢复最近工作上下文

---

## 当前进度

项目处于 **🚧 规划中**。下一步（PRD 第十章）：

1. ⬜ 创建 Tauri + Rust 工程
2. ⬜ 实现行为感知 MVP（键盘频率 + 空闲检测）
3. ⬜ 画 3 帧像素角色（干活/疲惫/瘫倒）
4. ⬜ 接通"感知 → 状态 → 动画 → 冒泡"链路
5. ⬜ 自己用 3 天，看会不会笑

---

> **Overworked** — 它替你打工，你替它活着。
