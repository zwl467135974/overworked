---
name: overworked_behavior_sensing
description: Use when touching keyboard/mouse input hooks, idle detection, active-window title reading, or any OS-level activity monitoring in Overworked (rdev, winapi, enigo, CoreGraphics, x11). This skill enforces the privacy red-line which is the project's technical lifeline — getting it wrong turns a cute pet into a keylogger accusation. Covers what may be sensed, what must NEVER be sensed, sampling strategy, the always-off-by-default window-title switch, and platform differences.
---

# Overworked 行为感知规范（隐私命门）

## 功能概述

行为感知是 Overworked 的技术核心——你的打字、鼠标、挂机、熬夜变成小生物的"打工事件"。但它也是**整个项目的技术命门**：稍有不慎就会被当成键盘记录器/木马，一个截图发出去项目就死了。

这个 skill 守的是设计红线 4（本地优先）的**技术边界**。

## 三条绝对红线（写进 DNA）

### 红线 A：绝不记录键盘输入内容

只统计**频率/节奏**，绝不捕获按键本身。

| ❌ 禁止 | ✅ 允许 |
|---|---|
| 记录按下了哪个键（哪怕只存 1 秒） | 5 秒窗口内的按键**计数** |
| 记录按键的时间戳序列（可被重建为输入） | "过去 5 秒按了 47 下"这个聚合数 |
| 区分字母键/功能键的内容 | 仅可区分"有按键活动"这一布尔/计数信号 |

**实现要点**：hook 回调里只做 `counter += 1`，回调结束后 counter 的增量被读走即清零。**不要在回调里保存任何 key code**。

### 红线 B：绝不截屏

- 不调用任何截屏 API
- 不读取屏幕像素
- 不录制屏幕

判断"在干嘛"只能靠**窗口标题**（见下，且默认关闭），不靠屏幕内容。

### 红线 C：绝不上传任何数据

- 所有行为数据只存在本地 SQLite
- 无遥测、无崩溃上报（除非严格 opt-in 且用户明示同意）
- Phase 3 的 LLM 文案生成若联网，必须用**用户自己的 API key**，且只发送"状态标签"（如 `tired`），不发送行为原始数据

## 感知项清单

| 感知项 | 方法 | 隐私等级 | 默认 | 用途 |
|---|---|---|---|---|
| 键盘按键**频率** | 全局 hook，只计数不存键 | ✅ 安全 | 开 | 判断"产能" |
| 鼠标移动距离/点击频率 | 全局 hook | ✅ 安全 | 开 | 判断"活跃度" |
| 系统空闲时长 | OS idle 检测 | ✅ 安全 | 开 | 判断"摸鱼/挂机" |
| 当前时间段 | 系统时钟 | ✅ 安全 | 开 | 判断"夜班/午休" |
| 前台窗口**标题** | OS API | ⚠️ 敏感 | **关** | 判断"在干嘛"（可选增强） |

**窗口标题感知的特别约束**（红线 5.3 的核心）：
- **默认关闭**，需用户在右键菜单主动开启（注意：MVP 右键菜单只有"暂时消失/关于/退出"三项，所以这个开关 Phase 2+ 才加）
- 开启后只读取**进程名或窗口类名**（如 "Code.exe"），尽量不存原始标题文本
- 原始标题绝不入库，只入"分类标签"（如 `coding` / `browsing` / `design`）

## 采样策略：低频聚合，不要事件驱动

**核心原则：按时间窗口聚合，不要每次输入都触发逻辑。**

```
❌ 错误：每次按键 hook 回调里更新体力
   → CPU 占用高，且行为数据可被高频重建

✅ 正确：hook 回调只累加计数器
        每 5 秒一个 tick，读走计数器 → 算"产能分" → 清零
        → 计数器只活 5 秒，无法重建输入
```

这同时满足性能预算（PRD 5.4：CPU 空闲 <1%、动画时 <3%）和隐私（高频原始信号无法被重建）。

## 平台差异速查

MVP 先做 Windows（PRD 目标），但代码要为跨平台留口子：

| 能力 | Windows | macOS | Linux |
|---|---|---|---|
| 键盘 hook | `windows` crate / `rdev` | `CGEventTap`（需"辅助功能"权限） | `evdev` / X11 record |
| 鼠标 hook | 同上 | 同上 | 同上 |
| 空闲检测 | `GetLastInputInfo` | `CGEventSourceSecondsSinceLastEventType` | XScreenSaver `XScreenSaverQueryInfo` |
| 窗口标题 | `GetForegroundWindow` + `GetWindowTextW` | `NSWorkspace.frontmostApplication` | X11 `_NET_ACTIVE_WINDOW` |
| 权限提示 | 无（全局 hook 默认可用） | 需用户在"系统设置→隐私→辅助功能"授权 | 视发行版 |

**macOS 特别提醒**：`CGEventTap` 在首次调用会触发系统权限弹窗，文案必须解释"只统计频率不记录内容"——这条说明要写进应用内文案，不能只靠系统弹窗。

## 实现骨架（Rust 伪码）

```rust
// 感知层只产出"聚合样本"，不产出原始事件流
pub struct BehaviorSample {
    pub window_start: Instant,
    pub key_count: u32,        // 5 秒内按键总数，不含 which key
    pub mouse_move_pixels: u32,
    pub mouse_click_count: u32,
    pub idle_seconds: u32,     // 本窗口末尾的系统空闲时长
    pub active_app_tag: Option<AppTag>,  // 仅当用户开启窗口标题感知
}

pub trait BehaviorSensor {
    /// 每 5 秒被引擎调用一次，取走并清零内部计数器
    fn sample_and_reset(&mut self) -> BehaviorSample;
}
```

注意：`BehaviorSample` 里**没有任何字段**能还原出"用户按了什么、看了什么"。这是设计红线 C 的代码体现。

## 与其他 skill 的关系

- 产出 `BehaviorSample` → 交给 `overworked_game_loop` 的状态机消费
- 感知层的位置和依赖方向，见 `overworked_architecture`
- 任何触发红线 A/B/C 的代码改动，**这个 skill 的检查清单必须全过**才能提交

## 检查清单（碰感知代码必过）

- [ ] hook 回调里没有保存任何 key code / 按键内容（红线 A）
- [ ] 没有调用任何截屏/录屏 API（红线 B）
- [ ] 没有新增任何网络请求/上传/遥测（红线 C）
- [ ] 采样是"5 秒窗口聚合"，不是"每次事件触发"（性能 + 隐私）
- [ ] 窗口标题感知默认关闭，且开启后只存分类标签不存原始标题
- [ ] `BehaviorSample` 结构体里没有任何字段能还原用户原始输入
- [ ] macOS 路径考虑了"辅助功能"权限说明文案
- [ ] 感知层 → 引擎层是单向数据流（`sample_and_reset` 返回值，不反向调用）
