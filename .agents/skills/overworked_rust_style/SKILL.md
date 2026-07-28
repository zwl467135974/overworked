---
name: overworked_rust_style
description: Use when writing or reviewing Rust code in the Overworked Tauri app (src-tauri/). Covers naming, module/file organization, ownership and borrowing patterns, error handling (Result/?, thiserror/anyhow), trait design for the sensing/engine/bridge layers, and idiomatic Rust for a long-running desktop app. Trigger on any .rs file creation or edit.
---

# Overworked Rust 代码风格规范

## 功能概述

Overworked 的 Rust 代码跑在 Tauri 主进程里，是个**长时间常驻**的桌面应用。这个 skill 守的是 Rust 写法的一致性——命名、模块、所有权、错误处理、trait 设计。

## 模块与文件

### 目录约定（与 `overworked_architecture` 对齐）

```
src-tauri/src/
├── main.rs                入口，注册 command、启动 sensing tick
├── sensing/               行为感知层
│   ├── mod.rs
│   ├── keyboard.rs
│   ├── mouse.rs
│   └── idle.rs
├── engine/                游戏引擎
│   ├── mod.rs
│   ├── state.rs           PetState（四属性，内部数值）
│   ├── events.rs          事件触发
│   └── save.rs            SQLite 存档
└── rendering_bridge/      数值 → 表情 + Tauri emit
    ├── mod.rs
    └── expression.rs      Expression 枚举
```

### 模块规则

- 一个模块一个目录 + `mod.rs`，目录名 `snake_case`
- 公开 API 通过 `mod.rs` 的 `pub use` 重导出，隐藏内部结构
- 超过 ~300 行的模块考虑拆子模块

```rust
// engine/mod.rs
mod state;
mod events;
mod save;

pub use state::{PetState, Expression};
pub use events::EventBus;
pub use save::SaveStore;
// 内部的 stamina/mood 字段不重导出 —— 红线 2 的代码体现
```

## 命名规范

| 类型 | 规则 | 示例 |
|---|---|---|
| 类型/结构体/枚举 | `UpperCamelCase` | `PetState`, `BehaviorSample`, `Expression` |
| 函数/方法 | `snake_case` | `sample_and_reset`, `apply_sample` |
| 局部变量 | `snake_case` | `key_count`, `idle_seconds` |
| 常量 | `SCREAMING_SNAKE_CASE` | `SAMPLE_WINDOW_SECS`, `MAX_STAMINA` |
| 模块/crate | `snake_case` | `sensing`, `rendering_bridge` |
| 生命周期 | 短小写 | `'a`, `'s` |
| trait | `UpperCamelCase`，能力用形容词 | `BehaviorSensor`, `Serializable` |

**布尔方法**用 `is_`/`has_` 前缀：`is_idle()`, `has_stamina()`。

## 所有权与借用

桌面常驻应用，要避免不必要的克隆和泄漏：

| 场景 | 做法 |
|---|---|
| 感知层计数器 | `AtomicU32` 或 `Mutex<Counter>`，hook 回调里只增不减 |
| 引擎状态 | 单一所有权，`Mutex<PetState>` 或 `RwLock<PetState>`（读多写少用 RwLock） |
| 跨线程共享 | `Arc<T>` 包 `Mutex`/`RwLock` |
| Tauri `AppHandle` | 按值克隆传递（它内部是 `Arc`，克隆便宜） |
| 行为样本 | 5 秒产一个，按值传递 `BehaviorSample`，不需要 Arc |

**避免**：
- 无意义的 `.clone()` —— 优先用引用，除非跨线程边界
- `Rc`/`RefCell` —— 多线程 Tauri 里基本用不上，用 `Arc`/`Mutex`
- 长生命周期持有大对象 —— 行为日志定期裁剪（见架构性能预算）

## 错误处理

### 分层用不同策略

| 层 | 策略 | 理由 |
|---|---|---|
| 感知层 | `Result<T, SensorError>` + `thiserror` | OS hook 失败要可区分（权限/平台/未实现） |
| 引擎层 | `Result<T, EngineError>` + `thiserror` | 状态机错误要精确 |
| 存档层 | `Result<T, SaveError>` | SQLite 错误隔离 |
| Tauri command 边界 | `?` 传播 + `anyhow` 或转字符串给前端 | command 返回值要序列化 |

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SensorError {
    #[error("platform not supported: {0}")]
    UnsupportedPlatform(String),
    #[error("permission denied (macOS accessibility?)")]
    PermissionDenied,
    #[error("hook install failed: {0}")]
    HookFailed(String),
}
```

### 不要 panic

桌面常驻应用 **panic = 用户看到崩溃**。规则：
- 业务代码用 `Result`，绝不 `unwrap()`/`expect()` 在非测试路径
- `unwrap()` 只允许在：测试代码、`const` 上下文、或"逻辑上不可能失败"且加注释说明
- 唯一可接受 panic 的场景：程序启动时的不变量校验（配置错误早死早超生）

## Trait 设计（与架构对齐）

各层用 trait 定义边界，便于测试和跨平台：

```rust
// 感知层接口 —— 各平台实现各写各的
pub trait BehaviorSensor: Send {
    fn sample_and_reset(&mut self) -> BehaviorSample;
}

// 引擎依赖 trait 而非具体实现，测试时可 mock
pub struct Engine<S: BehaviorSensor> {
    sensor: S,
    state: PetState,
    // ...
}
```

**跨平台要点**（呼应 `overworked_behavior_sensing`）：Windows/macOS/Linux 各一个 `BehaviorSensor` 实现，通过 `cfg(target_os = ...)` 切换。

## Tauri command 写法

```rust
#[tauri::command]
fn poke_pet(state: tauri::State<'_, Mutex<PetState>>) -> Result<(), String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.on_poke();  // 触发"哎！"反应
    Ok(())
}
```

- command 函数名 = 前端 `invoke` 的字符串，用 `snake_case`
- 错误返回用 `Result<T, String>` 或自定义可序列化错误（前端拿得到）
- 不在 command 里写业务逻辑，只做"取 state → 调方法 → 返回"

## 注释规范

```rust
/// 5 秒行为样本。所有字段都是聚合值，无法还原用户原始输入
/// （隐私红线 A/B/C —— 见 overworked_behavior_sensing）。
#[derive(Debug, Clone)]
pub struct BehaviorSample {
    /// 窗口内按键总数，不含 which key
    pub key_count: u32,
    // ...
}
```

- `///` 文档注释写在公开 API 上，解释"为什么"不是"是什么"
- 涉及设计红线的代码，注释里点明对应红线（便于 reviewer 溯源）
- 内部实现用 `//` 行注释，写决策理由，不写显而易见的事

## 异步与定时

- 5 秒采样 tick：用 `tokio::time::interval` 或 Tauri 的后台 task
- 不要在主线程做重活
- 动画相关的时间逻辑在前端（requestAnimationFrame），后端只推表情变化事件

## 检查清单

- [ ] 命名符合规范（类型/函数/常量/模块）
- [ ] 公开 API 通过 `mod.rs` 重导出，内部字段不泄露（红线 2）
- [ ] 没有 `unwrap()`/`expect()` 在非测试路径
- [ ] 错误用 `thiserror`/`anyhow`，按层分类
- [ ] 跨线程共享用 `Arc<Mutex>`/`Arc<RwLock>`，不用 `Rc`/`RefCell`
- [ ] 跨平台代码用 `cfg(target_os)` + trait 抽象
- [ ] Tauri command 只做薄封装，不含业务逻辑
- [ ] 涉及红线的代码有注释点明（"红线 A：不记内容"等）
- [ ] `cargo check` 通过（提交前）
