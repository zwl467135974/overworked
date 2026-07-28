---
name: overworked_architecture
description: Use when scaffolding the Tauri project, creating new Rust modules, organizing the workspace, or writing any Tauri command (#[tauri::command]) or event (emit/listen) bridging Rust and the web frontend in Overworked. Enforces the three-layer split (sensing / engine / rendering), the one-way data flow, the numeric-hiding boundary (no raw stats cross to frontend), and the performance budget.
---

# Overworked 架构规范（Tauri 三层）

## 功能概述

Overworked 跑在 Tauri 上：Rust 主进程做行为感知和游戏逻辑，内嵌 Web（Canvas）做像素动画。这个 skill 守的是**层次划分、依赖方向、前后端边界、性能预算**。

## 三层架构

```
src-tauri/                          ← Tauri 主进程（Rust）
├── sensing/                        层 1：行为感知
│   └── 产出 BehaviorSample（聚合样本，见 overworked_behavior_sensing）
│
├── engine/                         层 2：游戏引擎（核心）
│   ├── state/                      四属性状态机（体力/时薪/心情/存款）
│   ├── events/                     事件触发（番茄钟/夜班/过劳…）
│   └── save/                       SQLite 存档
│
└── rendering-bridge/               层 3：渲染桥（前端契约）
    └── 把内部状态映射成 Expression，通过 event 推给前端
        （原始数值绝不越过这条线 —— 设计红线 2）

src/                               ← 前端（Web / Canvas）
├── canvas/                         像素动画
├── bubbles/                        冒泡文字
└── 状态由后端 emit 驱动，前端不持数值
```

## 各层职责

### 层 1：行为感知（`sensing/`）

- 接 OS hook（键盘频率/鼠标/空闲/时钟）
- **只产出聚合样本 `BehaviorSample`**，不产出原始事件流
- 隐私红线由 `overworked_behavior_sensing` 守，这里不重复

**规则**：感知层**不知道**游戏逻辑。它不判断"这算不算熬夜"，只报"现在凌晨 2 点 + 过去 5 秒按了 60 下"。判断留给引擎。

### 层 2：游戏引擎（`engine/`）— 核心

- 消费 `BehaviorSample`，更新四属性（体力/时薪/心情/存款）
- 触发事件（番茄钟完成、过劳、离职…）
- 管理存档（SQLite）
- **持有全部原始数值，但绝不外泄**

### 层 3：渲染桥（`rendering-bridge/`）— 红线 2 的关键

这是**数值 → 表情**的翻译层。引擎内部的"体力=12"在这里变成 `Expression::Exhausted`，前端永远拿不到 12。

```rust
// 渲染桥对前端暴露的，只有这些"表情/姿态"枚举
pub enum Expression {
    Working,        // 干活
    Focused,        // 专注（番茄钟中）
    Tired,          // 疲惫
    Exhausted,      // 体力见底，瘫倒
    Overworked,     // 脸色发青，进医院前兆
    Idle,           // 带薪摸鱼
    NightShift,     // 夜班，黑眼圈
    Excited,        // 亢奋（产能高）
    Chaotic,        // 多线程混乱，眼神涣散
    Happy,          // 项目交付庆祝
}
```

## 前后端边界（Tauri 桥接）

### Rust → 前端：用 `emit` 推送表情

后端主动推，前端被动接收。前端**没有 invoke 查询数值的入口**。

```rust
// engine 状态变化后
app_handle.emit("expression-changed", &expression)?;
app_handle.emit("bubble-show", &BubbleText::from_pool(...))?;
```

前端 `listen("expression-changed", ...)` 切换动画，`listen("bubble-show", ...)` 弹冒泡。

### 前端 → Rust：用 `invoke` 命令（极简）

前端能发起的 command **白名单很短**，且全部不带数值语义：

| Command | 用途 | 是否违反红线 |
|---|---|---|
| `poke_pet` | 点击它一下 → "哎！" | ✅ 纯交互 |
| `dismiss_temporarily` | 右键"暂时消失 1 小时" | ✅ |
| `quit_app` | 右键"退出" | ✅ |
| `drag_to_position` | 拖动定位（它会自己走回角落） | ✅ |

**禁止的 command**：`get_stats`、`get_stamina`、`set_difficulty`、`configure_*` —— 任何读写数值或暴露配置的入口都违反红线 2/3。

## 依赖方向（单向，不可逆）

```
sensing ──→ engine ──→ rendering-bridge ──→ frontend
   (产出)     (消费+持有)    (翻译)            (展示)
```

- `engine` 可以调 `sensing` 的 `sample_and_reset()`，反过来不行
- `rendering-bridge` 只读 `engine` 的"表情视图"，不读原始数值
- `sensing` 对上层一无所知，是最纯净的一层

违反依赖方向（比如 engine 反向 import 了 rendering-bridge 的东西）= 架构错误。

## 性能预算（PRD 5.4，不可超）

| 指标 | 预算 | 守法手段 |
|---|---|---|
| 内存 | < 80MB（Tauri 基础 30-50MB，留给游戏 30MB） | 不在前端缓存动画帧图集、不无限增长行为日志 |
| CPU 空闲 | < 1% | 感知用 5 秒低频采样，不用事件驱动 |
| CPU 动画 | < 3% | Canvas 用 requestAnimationFrame，静止时不重绘 |
| 行为日志 | 不无限增长 | SQLite 定期裁剪/聚合，只留聚合统计不留明细 |

## Tauri 工程结构（建议）

```
overworked/
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json        ← transparent: true, always_on_top, 无边框
│   └── src/
│       ├── main.rs            ← Tauri 启动 + command 注册
│       ├── sensing/
│       ├── engine/
│       └── rendering_bridge/
├── src/                        ← 前端（HTML/JS/Canvas）
│   ├── main.ts
│   ├── canvas/
│   └── bubbles/
└── package.json
```

`tauri.conf.json` 关键项（与红线 3"不抢焦点"相关）：
- `app.windows[0].transparent: true`
- `app.windows[0].alwaysOnTop: true`
- `app.windows[0].decorations: false`（无边框）
- `app.windows[0].resizable: false`
- `app.windows[0].focus: false`（启动不抢焦点）

## 与其他 skill 的关系

- 层 1 的实现细节 + 隐私红线 → `overworked_behavior_sensing`
- 层 2 的状态机/事件/文案 → `overworked_game_loop`
- 整个项目的灵魂（三条红线在这里的体现：数值不越界、不抢焦点、本地优先） → `overworked_design_principles`
- Rust 写法 → `overworked_rust_style`

## 检查清单

- [ ] 新代码放对了层（感知/引擎/桥，不串层）
- [ ] 依赖方向是单向的（sensing → engine → bridge → frontend）
- [ ] 没有给前端加任何"查数值"的 command（红线 2）
- [ ] 新增 command 在白名单理念内（纯交互，无数值语义）
- [ ] 后端推前端用的是 `Expression` 等表情枚举，不是原始数值
- [ ] 感知层保持低频采样（5 秒窗口）
- [ ] 内存/CPU 在预算内（<80MB / 空闲<1% / 动画<3%）
- [ ] `tauri.conf.json` 的窗口配置保持"不抢焦点"（transparent/alwaysOnTop/no-focus）
