// Overworked 游戏引擎 —— 事件层（桩）
//
// MVP 阶段：事件系统只留接口，不实现具体事件。
// Phase 2+ 会接入：番茄钟完成、进医院、离职/升职/团建等特殊事件
// （见 PRD 3.4 特殊事件表 + overworked_game_loop）。
//
// 新增事件前必须先过 overworked_design_principles 的五条红线过滤器。

/// 引擎可能产出的事件。MVP 暂未使用，留作接口契约。
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum GameEvent {
    /// 瘫倒（体力归零）—— 第一个传播点
    Collapsed,
    /// 夜班（凌晨 1-5 点仍在活动）
    NightShift,
    /// 被戳了一下 → "哎！"
    Poked,
}

/// 事件总线（MVP 桩）。
/// Phase 2 会实现：事件队列 + 节流 + 触发条件检测。
#[derive(Default)]
pub struct EventBus;

#[allow(dead_code)]
impl EventBus {
    pub fn new() -> Self {
        Self
    }

    /// MVP：空实现。Phase 2 在此检测事件触发条件并入队。
    pub fn poll(&mut self) -> Vec<GameEvent> {
        Vec::new()
    }
}
