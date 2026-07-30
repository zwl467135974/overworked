// Overworked 游戏引擎 —— 层 2（核心）
//
// 职责：消费 BehaviorSample，更新四属性状态，产出表情 + 事件。
// 持有全部原始数值，是红线 2 的最后一道屏障 ——
// 任何对外暴露都只走 expression()，不暴露数字。

pub mod events;
pub mod save;
pub mod state;

// events 的 EventBus/GameEvent 在 MVP 骨架阶段暂未被主循环使用，
// Phase 2 接入事件触发后会用到。暂时 allow unused_imports。
#[allow(unused_imports)]
pub use events::{EventBus, GameEvent};
pub use state::{
    breakthrough_price, breakthrough_rate, realm_name, CultEvent, CultivationPayload, PetState,
    StatsPayload, TickEvent,
};
