// Overworked 游戏引擎 —— 四属性状态机（内部数值，绝不外泄）
//
// 设计红线 2（不暴露数值）的核心执行点：
// 四个属性全部私有字段，外部（包括前端、包括 Tauri command）
// 无法读取 stamina/mood/hourly_wage/savings 的具体数字。
// 唯一的对外窗口是 expression()，把数值翻译成表情。
//
// 数值 → 表情 的映射原则（见 overworked_game_loop）：
// 区间映射，不是线性映射。数值连续，表情离散。

use std::time::{Duration, Instant};

use super::save;
use crate::rendering_bridge::Expression;
use crate::sensing::BehaviorSample;
use serde::Serialize;

/// 数值面板载荷（红线2 调整后：四属性对前端可见，驱动常驻细条）。
#[derive(Debug, Clone, Copy, Serialize)]
pub struct StatsPayload {
    pub stamina: f32,      // 0-100
    pub mood: f32,         // 0-100
    pub hourly_wage: f32,  // 浮动
    pub savings: f32,      // 累积
}

/// 修仙面板载荷（修仙模式下放开的红线：境界/修为/灵石全可见）。
/// 普通模式下 frontend 收到 cultivation_mode=false，不渲染此区。
#[derive(Debug, Clone, Copy, Serialize)]
pub struct CultivationPayload {
    pub cultivation_mode: bool, // 是否修仙模式
    pub realm: i64,             // 0-6
    pub exp: f32,               // 0-100
    pub savings: f32,           // 灵石=存款（共用）
    pub qi_pill: i64,
    pub life_pill: i64,
    pub spirit_talisman: i64,
}

/// 修仙相关事件（与 TickEvent 平行，由 buy_item 等指令路径返回）。
#[derive(Debug, Clone)]
pub enum CultEvent {
    CultivationOn,   // 开启修仙模式（凡人→练气）
    CultivationOff,  // 切回普通模式
    Bought { item: String }, // 购买道具
    RealmUp(i64),    // 突破升境界
    Deviation,       // 走火入魔
    Ascension,       // 飞升
}

/// 境界信息表
const REALM_NAMES: [&str; 7] = [
    "凡人", "练气", "筑基", "金丹", "元婴", "化神", "飞升",
];

/// 突破丹价（按当前境界索引）
const BREAKTHROUGH_PILL_PRICE: [i64; 6] = [200, 500, 1000, 3000, 8000, 99999];
/// 突破成功率（按当前境界索引，越高越难）
const BREAKTHROUGH_RATE: [f32; 6] = [0.90, 0.85, 0.80, 0.70, 0.60, 0.50];

pub fn realm_name(realm: i64) -> &'static str {
    REALM_NAMES.get(realm as usize).copied().unwrap_or("？？？")
}

pub fn breakthrough_price(realm: i64) -> i64 {
    BREAKTHROUGH_PILL_PRICE.get(realm as usize).copied().unwrap_or(99999)
}

pub fn breakthrough_rate(realm: i64) -> f32 {
    BREAKTHROUGH_RATE.get(realm as usize).copied().unwrap_or(0.5)
}

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
    /// 连续专注秒数（番茄钟用）。挂机超30秒则清零。
    focus_seconds: f32,
    /// 在医院直到何时（None=不在医院）。体力归零触发，5分钟出院。
    hospital_until: Option<Instant>,
    /// 连续挂机时长（秒），用于 Boss来了检测
    idle_seconds_accum: f32,
}

/// 事件结果——apply_sample 可能产生的事件，由调用方 emit 给前端。
#[derive(Debug, Clone)]
pub enum TickEvent {
    // Phase 2
    PomodoroComplete,
    HospitalAdmit,
    HospitalDischarge,
    // Phase 3 特殊事件
    LunchNap,
    Payday(i64),
    TeamBuilding,
    Promoted,
    VacationStart,
    VacationEnd,
    Leave,
    ReturnFromLeave,
    // 趣味玩法
    BossIncoming,  // Boss来了（摸鱼被抓：长时间挂机后突然疯狂打字）
    CoffeeBoost,   // 投喂咖啡（command 触发，体力恢复）
    // 修仙：续命丹救命（消耗一颗续命丹，免于过劳送医）
    LifeSaved,
}

impl PetState {
    pub fn new() -> Self {
        Self {
            stamina: 80.0,
            hourly_wage: 35.0,
            mood: 70.0,
            savings: 0.0,
            last_tick: Instant::now(),
            focus_seconds: 0.0,
            hospital_until: None,
            idle_seconds_accum: 0.0,
        }
    }

    /// 从存档快照恢复。事件追踪字段重置（不跨会话维持）。
    pub fn from_snapshot(snap: save::StateSnapshot) -> Self {
        Self {
            stamina: snap.stamina,
            hourly_wage: snap.hourly_wage,
            mood: snap.mood,
            savings: snap.savings,
            last_tick: Instant::now(),
            focus_seconds: 0.0,
            hospital_until: None,
            idle_seconds_accum: 0.0,
        }
    }

    /// 导出存档快照（存档时用）。不暴露 getter，snapshot 是内部转换。
    pub fn to_snapshot(&self) -> save::StateSnapshot {
        save::StateSnapshot {
            stamina: self.stamina,
            hourly_wage: self.hourly_wage,
            mood: self.mood,
            savings: self.savings,
        }
    }

    /// 导出数值面板载荷（红线2 调整后对前端可见，驱动常驻细条）。
    pub fn to_stats_payload(&self) -> StatsPayload {
        StatsPayload {
            stamina: self.stamina,
            mood: self.mood,
            hourly_wage: self.hourly_wage,
            savings: self.savings,
        }
    }

    /// 离线恢复：离线期间"在睡觉"，按时长恢复体力。
    /// 约 8 小时满血（速率 ~12.5/小时）。心情也小幅恢复（睡了个好觉）。
    pub fn apply_offline_recovery(&mut self, offline_secs: u64) {
        if offline_secs == 0 {
            return;
        }
        let hours = offline_secs as f32 / 3600.0;
        // 体力恢复：每小时 +12.5，上限 100
        self.stamina = (self.stamina + hours * 12.5).min(100.0);
        // 心情小幅恢复：每小时 +3（睡好心情好），上限 100
        self.mood = (self.mood + hours * 3.0).min(100.0);
        self.last_tick = Instant::now();
    }

    /// 消费一个 5 秒行为样本，推进四属性，可能触发事件。
    ///
    /// 返回本 tick 产生的事件列表（番茄钟完成/进医院/出院），调用方 emit 给前端。
    /// 消费一个 5 秒行为样本，推进四属性，可能触发事件。
    /// ev_state 是事件追踪状态（跨会话），now_secs 是当前系统时间戳（事件判断用）。
    pub fn apply_sample(
        &mut self,
        sample: &BehaviorSample,
        ev: &mut save::EventState,
        now_secs: u64,
    ) -> Vec<TickEvent> {
        let now = Instant::now();
        let dt = now.duration_since(self.last_tick).as_secs_f32().max(0.1);
        self.last_tick = now;
        let mut events = Vec::new();

        // ===== 度假中检查（最高优先级，期间什么都不做）=====
        if ev.vacation_until > 0 && (now_secs as i64) < ev.vacation_until {
            return events; // 还在度假
        }
        if ev.vacation_until > 0 && (now_secs as i64) >= ev.vacation_until {
            // 度假结束
            ev.vacation_until = 0;
            self.mood = 100.0; // 度假回来心情满
            events.push(TickEvent::VacationEnd);
        }

        // ===== 离职回归检查 =====
        if ev.leave_until > 0 && (now_secs as i64) >= ev.leave_until {
            ev.leave_until = 0;
            ev.pet_variant += 1; // 形态微变（领带色变等）
            self.mood = 70.0;    // 回归心情重置
            self.stamina = 80.0;
            events.push(TickEvent::ReturnFromLeave);
        }
        if ev.leave_until > 0 {
            return events; // 还在离职期，不推进
        }

        // ===== 医院检查 =====
        if let Some(until) = self.hospital_until {
            if now < until {
                return events;
            } else {
                self.hospital_until = None;
                self.stamina = 60.0;
                self.mood = (self.mood + 20.0).min(100.0);
                events.push(TickEvent::HospitalDischarge);
                return events;
            }
        }

        // ===== 时间信息（本地时区，MVP）=====
        let hour = get_local_hour();
        let today = today_str_from_secs(now_secs);
        let weekday = weekday_from_secs(now_secs); // 0=周日, 5=周五
        let month = month_from_secs(now_secs);

        // ===== 正常数值推进 =====
        let keys_per_sec = sample.key_count as f32 / dt;
        let is_working = keys_per_sec > 1.0;
        let is_idling = sample.idle_seconds >= 30;

        if is_working {
            self.stamina -= (keys_per_sec * 0.15) * dt;
            self.hourly_wage += keys_per_sec * 0.02 * dt;
            // 存款增长：游戏化加速（×60），让打字能肉眼可见地攒钱。
            // 原真实换算 hourly_wage*dt/3600 太慢（时薪35打工1分钟才涨0.6），
            // 加速后打工1分钟约涨35，几分钟就能攒够500灵石入门修仙。
            self.savings += self.hourly_wage * dt / 60.0;
            self.mood -= 0.2 * dt;
            self.focus_seconds += dt;
            // Boss来了检测：挂机超 2 分钟后突然疯狂打字（keys_per_sec > 3）
            if self.idle_seconds_accum > 120.0 && keys_per_sec > 3.0 {
                self.idle_seconds_accum = 0.0;
                events.push(TickEvent::BossIncoming);
            }
            self.idle_seconds_accum = 0.0; // 打字清零挂机计时
        } else if is_idling {
            self.stamina += 1.5 * dt;
            self.mood += 1.2 * dt;
            self.focus_seconds = 0.0;
            self.idle_seconds_accum += dt; // 累计挂机时长
        } else {
            self.stamina += 0.5 * dt;
            self.mood += 0.4 * dt;
            self.idle_seconds_accum += dt;
        }

        // 钳制
        self.stamina = self.stamina.clamp(0.0, 100.0);
        self.hourly_wage = self.hourly_wage.clamp(15.0, 200.0);
        self.mood = self.mood.clamp(0.0, 100.0);

        // ===== 修为积累（修仙模式专属） =====
        // 红线放开：数值可见、游戏化。打工/挂机/专注都积累，专注最快。
        // 聚灵符期间 ×2。
        if ev.cultivation_mode && ev.cultivation_realm < 6 {
            let boost = now_secs as i64 <= ev.spirit_boost_until;
            let mult = if boost { 2.0 } else { 1.0 };
            let gain = if is_working {
                // 打工每秒 +0.2（5 秒约 +1）
                0.2 * dt * mult
            } else if is_idling {
                0.1 * dt * mult
            } else {
                0.05 * dt * mult
            };
            ev.cultivation_exp = (ev.cultivation_exp + gain * 10.0).min(100.0);
        }

        // ===== 番茄钟检查 =====
        const FOCUS_THRESHOLD: f32 = 1500.0; // 25 分钟
        if self.focus_seconds >= FOCUS_THRESHOLD {
            self.focus_seconds = 0.0;
            self.savings += 200.0; // 项目交付奖金
            self.mood = (self.mood + 15.0).min(100.0); // 交付心情大好
            // 修仙模式：交付=悟道，修为大涨
            if ev.cultivation_mode && ev.cultivation_realm < 6 {
                let boost = now_secs as i64 <= ev.spirit_boost_until;
                let g = if boost { 40.0 } else { 20.0 };
                ev.cultivation_exp = (ev.cultivation_exp + g).min(100.0);
            }
            events.push(TickEvent::PomodoroComplete);
        }

        // ===== 过劳送医检查（修仙：续命丹可救命）=====
        if self.stamina <= 0.0 {
            if ev.cultivation_mode && ev.item_life_pill > 0 {
                // 续命丹救命：消耗一颗，体力回 50，不进医院
                ev.item_life_pill -= 1;
                self.stamina = 50.0;
                self.mood = (self.mood + 10.0).min(100.0);
                events.push(TickEvent::LifeSaved);
            } else {
                self.hospital_until = Some(now + Duration::from_secs(300));
                events.push(TickEvent::HospitalAdmit);
            }
        }

        // ===== Phase 3 特殊事件 =====

        // 午休：12-13点 + 挂机
        if hour == 12 && is_idling {
            events.push(TickEvent::LunchNap);
        }

        // 发工资：每月1号（防同月重复）
        if today.ends_with("-01") && ev.last_payday_month != month {
            ev.last_payday_month = month;
            let salary = (self.hourly_wage * 8.0 * 22.0) as i64; // 月薪估算
            self.savings += salary as f32;
            events.push(TickEvent::Payday(salary));
        }

        // 团建：周五 + 下午 + 挂机（每周1次）
        if weekday == 5 && hour >= 14 && hour < 18 && is_idling && ev.last_teambuilding_day != today {
            ev.last_teambuilding_day = today.clone();
            events.push(TickEvent::TeamBuilding);
        }

        // 升职：存款>=2000 且未升过
        if self.savings >= 2000.0 && !ev.has_promoted {
            ev.has_promoted = true;
            self.mood = 100.0;
            events.push(TickEvent::Promoted);
        }

        // 度假：存款>=3000（升职后继续攒够）
        if self.savings >= 3000.0 && ev.vacation_until == 0 && ev.has_promoted {
            ev.vacation_until = (now_secs as i64) + 3 * 86400; // 3天后
            self.savings -= 1500.0; // 度假花钱
            events.push(TickEvent::VacationStart);
        }

        // 离职：每天检查心情，连续3天=0则离职
        if ev.last_mood_day != today {
            ev.last_mood_day = today.clone();
            if self.mood <= 0.0 {
                ev.mood_zero_days += 1;
            } else {
                ev.mood_zero_days = 0;
            }
        }
        if ev.mood_zero_days >= 3 && ev.leave_until == 0 {
            ev.leave_until = (now_secs as i64) + 3 * 86400; // 3天后回归
            ev.mood_zero_days = 0;
            events.push(TickEvent::Leave);
        }

        events
    }

    /// 是否在医院（前端/外部查询用，决定是否强制 exhausted）。
    pub fn is_in_hospital(&self) -> bool {
        self.hospital_until.is_some()
    }

    // ===== 调试触发器（右键菜单"事件触发"用，直接产生事件效果） =====

    /// 手动触发番茄钟完成效果。
    pub fn trigger_pomodoro(&mut self) {
        self.focus_seconds = 0.0;
        self.savings += 200.0;
        self.mood = (self.mood + 15.0).min(100.0);
    }

    /// 手动触发进医院。
    pub fn trigger_hospital(&mut self) {
        self.stamina = 0.0;
        self.hospital_until = Some(Instant::now() + Duration::from_secs(300));
    }

    /// 手动触发出院。
    pub fn trigger_discharge(&mut self) {
        self.hospital_until = None;
        self.stamina = 60.0;
        self.mood = (self.mood + 20.0).min(100.0);
    }

    /// 投喂咖啡：体力 +30，心情 +10（续命）。
    pub fn drink_coffee(&mut self) {
        self.stamina = (self.stamina + 30.0).min(100.0);
        self.mood = (self.mood + 10.0).min(100.0);
    }

    /// 导出修仙面板载荷（修仙模式下放开红线，数值全可见）。
    pub fn to_cultivation_payload(&self, ev: &save::EventState) -> CultivationPayload {
        CultivationPayload {
            cultivation_mode: ev.cultivation_mode,
            realm: ev.cultivation_realm,
            exp: ev.cultivation_exp,
            savings: self.savings,
            qi_pill: ev.item_qi_pill,
            life_pill: ev.item_life_pill,
            spirit_talisman: ev.item_spirit_talisman,
        }
    }

    // ===== 修仙指令路径（command 调用，返回事件列表） =====

    /// 切换修仙模式。
    /// 开启前提：存款 >= 500（买得起入门券）。
    /// 关闭：随时可关。
    pub fn toggle_cultivation(
        &mut self,
        ev: &mut save::EventState,
        now_secs: u64,
    ) -> Result<Vec<CultEvent>, String> {
        let mut events = Vec::new();
        if ev.cultivation_mode {
            // 切回普通模式
            ev.cultivation_mode = false;
            events.push(CultEvent::CultivationOff);
            Ok(events)
        } else {
            // 开启：扣 500 灵石，进入练气期
            if self.savings < 500.0 {
                return Err("灵石不足，入门券需要 500".into());
            }
            self.savings -= 500.0;
            ev.cultivation_mode = true;
            ev.cultivation_realm = 1; // 凡人→练气
            ev.cultivation_exp = 0.0;
            events.push(CultEvent::CultivationOn);
            let _ = now_secs;
            Ok(events)
        }
    }

    /// 购买道具。item 取值: "qi_pill" | "life_pill" | "spirit_talisman" | "breakthrough_pill"
    pub fn buy_item(
        &mut self,
        ev: &mut save::EventState,
        item: &str,
        now_secs: u64,
    ) -> Result<Vec<CultEvent>, String> {
        if !ev.cultivation_mode {
            return Err("需先开启修仙模式".into());
        }
        let price = match item {
            "qi_pill" => 50,
            "life_pill" => 100,
            "spirit_talisman" => 200,
            "breakthrough_pill" => breakthrough_price(ev.cultivation_realm),
            _ => return Err("未知道具".into()),
        };
        if (self.savings as i64) < price {
            return Err(format!("灵石不足，需要 {}", price));
        }
        self.savings -= price as f32;
        let mut events = Vec::new();
        match item {
            "qi_pill" => {
                ev.item_qi_pill += 1;
                // 立即回气（其实也可以先持有再激活；这里直接生效，简化）
                self.stamina = (self.stamina + 50.0).min(100.0);
            }
            "life_pill" => {
                ev.item_life_pill += 1;
            }
            "spirit_talisman" => {
                ev.item_spirit_talisman += 1;
                // 立即激活：修为 ×2 持续 1 小时
                ev.spirit_boost_until = (now_secs as i64) + 3600;
            }
            "breakthrough_pill" => {
                // 突破丹：直接尝试突破
                return self.attempt_breakthrough(ev, now_secs);
            }
            _ => {}
        }
        events.push(CultEvent::Bought {
            item: item.to_string(),
        });
        Ok(events)
    }

    /// 尝试突破。需修为满 100，消耗一颗突破丹（由 buy_item("breakthrough_pill") 触发）。
    pub fn attempt_breakthrough(
        &mut self,
        ev: &mut save::EventState,
        _now_secs: u64,
    ) -> Result<Vec<CultEvent>, String> {
        if !ev.cultivation_mode {
            return Err("需先开启修仙模式".into());
        }
        if ev.cultivation_realm >= 6 {
            return Err("已飞升，无境可破".into());
        }
        if ev.cultivation_exp < 100.0 {
            return Err(format!(
                "修为不足（{:.0}/100）",
                ev.cultivation_exp
            ));
        }
        let rate = breakthrough_rate(ev.cultivation_realm);
        let roll: f32 = {
            // 简单 LCG 伪随机（不依赖 rand crate）
            let seed = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0);
            let s = seed.wrapping_mul(2654435761).wrapping_add(1);
            ((s >> 32) as f32) / (u32::MAX as f32)
        };
        let mut events = Vec::new();
        if roll < rate {
            // 突破成功
            ev.cultivation_realm += 1;
            ev.cultivation_exp = 0.0;
            if ev.cultivation_realm >= 6 {
                events.push(CultEvent::Ascension);
            } else {
                events.push(CultEvent::RealmUp(ev.cultivation_realm));
            }
        } else {
            // 走火入魔：修为清零 + 体力降到 20
            ev.cultivation_exp = 0.0;
            self.stamina = 20.0;
            events.push(CultEvent::Deviation);
        }
        Ok(events)
    }

    /// 数值 → 表情 的唯一出口。
    ///
    /// 这就是红线 2 的守门人：调用方拿到的是 Expression，
    /// 拿不到 47.0 这种数字。前端也只能收到表情。
    pub fn expression(&self) -> Expression {
        // 在医院：强制躺平（exhausted）
        if self.is_in_hospital() {
            return Expression::Exhausted;
        }
        // 夜班判断（凌晨 1-5 点）
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
    0
}

/// 从 Unix 时间戳算今日 YYYY-MM-DD（本地时区近似，用 get_local_hour 的平台逻辑）。
pub fn today_str_from_secs(secs: u64) -> String {
    // MVP：用 UTC 日期 + 本地小时偏移近似。够用。
    let days = secs / 86400;
    date_from_days(days)
}

/// 从 Unix 时间戳算星期（0=周日, 5=周五, 6=周六）。
pub fn weekday_from_secs(secs: u64) -> u32 {
    // 1970-01-01 是周四（4）。算 (4 + days) % 7。
    let days = secs / 86400;
    ((4 + days) % 7) as u32
}

/// 从 Unix 时间戳算月份（1-12）。
fn month_from_secs(secs: u64) -> i64 {
    let days = secs / 86400;
    let date = date_from_days(days);
    let parts: Vec<&str> = date.split('-').collect();
    parts.get(1).and_then(|m| m.parse().ok()).unwrap_or(1)
}

/// 天数（since epoch）转 YYYY-MM-DD。
fn date_from_days(days: u64) -> String {
    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", year, m, d)
}
