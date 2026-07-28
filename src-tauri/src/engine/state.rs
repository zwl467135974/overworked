// Overworked 游戏引擎 —— 四属性状态机（内部数值，绝不外泄）
//
// 设计红线 2（不暴露数值）的核心执行点：
// 四个属性全部私有字段，外部（包括前端、包括 Tauri command）
// 无法读取 stamina/mood/hourly_wage/savings 的具体数字。
// 唯一的对外窗口是 expression()，把数值翻译成表情。
//
// 数值 → 表情 的映射原则（见 overworked_game_loop）：
// 区间映射，不是线性映射。数值连续，表情离散。

use std::time::Instant;

use crate::rendering_bridge::Expression;
use crate::sensing::BehaviorSample;

/// 像素打工仔的完整内部状态。
///
/// 四个属性对应 PRD 3.3：
/// - stamina: 体力 0-100，打字消耗，挂机恢复，归零进医院
/// - hourly_wage: 时薪浮动，专注涨摸鱼掉
/// - mood: 心情 0-100，过劳降，归零摆烂
/// - savings: 存款累积，攒够去旅游
///
/// **所有字段私有**：绝不写 pub fn stamina(&self) -> f32 这种 getter。
pub struct PetState {
    stamina: f32,
    hourly_wage: f32,
    mood: f32,
    savings: f32,
    /// 上一次状态更新时间，用于按时间推进
    last_tick: Instant,
}

impl PetState {
    pub fn new() -> Self {
        Self {
            stamina: 80.0,        // 起步别太满，让用户能立刻看到反应
            hourly_wage: 35.0,    // 浮动起点
            mood: 70.0,
            savings: 0.0,
            last_tick: Instant::now(),
        }
    }

    /// 消费一个 5 秒行为样本，推进四属性。
    ///
    /// MVP 映射（见 overworked_game_loop 行为→状态表）：
    /// - 有按键活动 → 体力消耗 + 时薪维持
    /// - 无活动（挂机）→ 体力恢复
    /// - 不实现心情/存款的复杂逻辑，留 Phase 2
    pub fn apply_sample(&mut self, sample: &BehaviorSample) {
        let now = Instant::now();
        let dt = now.duration_since(self.last_tick).as_secs_f32();
        self.last_tick = now;

        // 按键活动强度：每秒按键数（粗略归一化）
        let keys_per_sec = sample.key_count as f32 / dt.max(1.0);

        if keys_per_sec > 1.0 {
            // 在打工：体力下降，时薪随产能微涨
            self.stamina -= keys_per_sec * 0.5 * dt.max(1.0);
            self.hourly_wage += keys_per_sec * 0.1;
        } else if sample.idle_seconds >= 30 {
            // 带薪摸鱼：体力恢复
            self.stamina += 2.0 * dt.max(1.0);
        }

        // 钳制到合法区间
        self.stamina = self.stamina.clamp(0.0, 100.0);
        self.hourly_wage = self.hourly_wage.clamp(15.0, 200.0);
        self.mood = self.mood.clamp(0.0, 100.0);
    }

    /// 数值 → 表情 的唯一出口。
    ///
    /// 这就是红线 2 的守门人：调用方拿到的是 Expression，
    /// 拿不到 47.0 这种数字。前端也只能收到表情。
    pub fn expression(&self) -> Expression {
        // 夜班判断（凌晨 1-5 点）—— 简化：由调用方传入更准，MVP 先内联
        // TODO: 夜班逻辑移到 events 层，state 只管数值
        if self.is_night_shift() {
            return Expression::NightShift;
        }
        // 体力区间映射（见 overworked_game_loop）
        match self.stamina {
            s if s <= 0.0 => Expression::Exhausted,
            s if s < 15.0 => Expression::Overworked,
            s if s < 40.0 => Expression::Tired,
            _ => Expression::Working,
        }
    }

    /// 点击它一下 → 触发"哎！"反应（MVP 必做交互）。
    /// 当前仅触发一次亢奋表情闪现，数值不变（避免点击刷数值）。
    pub fn on_poke(&mut self) {
        // MVP：poke 不改数值，只由调用方临时 emit Excited。
        // Phase 2 可加短暂的心情波动。
    }

    fn is_night_shift(&self) -> bool {
        // 用系统本地时间判断凌晨 1-5 点
        // (简版：后续接 chrono)
        let hour = get_local_hour();
        matches!(hour, 1..=4)
    }
}

impl Default for PetState {
    fn default() -> Self {
        Self::new()
    }
}

/// 临时本地小时获取（不引入 chrono，MVP 够用）。
/// Windows 下用 GetLocalTime，避免依赖。
#[cfg(windows)]
fn get_local_hour() -> u32 {
    use std::mem::MaybeUninit;
    #[repr(C)]
    struct SystemTime {
        _year: u16,
        _month: u16,
        _day_of_week: u16,
        _day: u16,
        hour: u16,
        _minute: u16,
        _second: u16,
        _milliseconds: u16,
    }
    extern "system" {
        fn GetLocalTime(lpsystemtime: *mut SystemTime);
    }
    unsafe {
        let mut st = MaybeUninit::<SystemTime>::uninit();
        GetLocalTime(st.as_mut_ptr());
        st.assume_init().hour as u32
    }
}

#[cfg(not(windows))]
fn get_local_hour() -> u32 {
    // 非 Windows 暂返回 0（不触发夜班），后续接 chrono 跨平台统一
    0
}
