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
    pub status: Status,    // 当前特殊状态（正常/度假/离职/住院）
    pub pet_variant: i64,  // 过劳变异次数（0=正常，越高越沧桑）
}

/// 桌宠的特殊状态（影响数值是否推进）。
/// 前端据此显示状态横幅，让用户知道"为什么数值不动"。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub enum Status {
    Normal,     // 正常打工
    Vacation,   // 度假中（数值冻结）
    OnLeave,    // 离职期（数值冻结）
    Hospital,   // 住院中（数值冻结）
}

/// 修仙面板载荷（修仙模式下放开的红线：境界/修为/灵石全可见）。
/// 普通模式下 frontend 收到 cultivation_mode=false，不渲染此区。
#[derive(Debug, Clone, Copy, Serialize)]
pub struct CultivationPayload {
    pub cultivation_mode: bool, // 是否修仙模式
    pub realm: i64,             // 0-6
    pub exp: f32,               // 0-100
    pub savings: f32,           // 灵石=存款（共用）
    pub stamina: f32,           // 体力 0-100
    pub inner_demon: f32,       // 心魔 0-100
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
    MountEquipped(i64), // 装备坐骑(1-5)
    MountUnequipped,    // 卸下坐骑
    SpellCast { spell: String }, // 施展法术
}

/// 境界信息表
const REALM_NAMES: [&str; 7] = [
    "凡人", "练气", "筑基", "金丹", "元婴", "化神", "飞升",
];

/// 突破丹价（按当前境界索引）——降低中后期价格，减少卡顿感
const BREAKTHROUGH_PILL_PRICE: [i64; 6] = [200, 400, 800, 1500, 3000, 99999];
/// 突破成功率（按当前境界索引，越高越难）——略提高，减少挫败感
const BREAKTHROUGH_RATE: [f32; 6] = [0.92, 0.88, 0.82, 0.75, 0.65, 0.55];

/// 心魔丹价格（按境界递增）
const HEART_DEVIL_PILL_PRICE: [i64; 6] = [100, 200, 400, 800, 1500, 3000];

/// 坐骑信息表（索引 1-5 对应 mount_id）
/// (名称, 价格, 最低境界要求)
const MOUNT_INFO: [(&str, i64, i64); 6] = [
    ("无", 0, 0),       // 0=占位
    ("飞剑", 1000, 1),  // 1
    ("葫芦", 2000, 2),  // 2
    ("青龙", 5000, 3),  // 3
    ("麒麟", 8000, 4),  // 4
    ("凤凰", 15000, 5), // 5
];

/// 法术信息表
/// (名称, 价格)
const SPELL_INFO: [(&str, i64); 5] = [
    ("fireball", 300),     // 火球术
    ("ice", 600),          // 冰封术
    ("thunder", 1200),     // 雷劫术
    ("swords", 3000),      // 万剑诀
    ("armageddon", 8000),  // 天地同寿
];

/// 法术施展：体力消耗（按阶位递增）
const SPELL_STAMINA_COST: [f32; 5] = [10.0, 15.0, 20.0, 30.0, 45.0];
/// 法术施展：修为收益（按阶位递增）
const SPELL_GAIN_EXP: [f32; 5] = [5.0, 8.0, 12.0, 18.0, 25.0];
/// 法术施展：时薪收益（按阶位递增）—— 施法如工作，越强收获越大
const SPELL_GAIN_WAGE: [f32; 5] = [3.0, 5.0, 8.0, 12.0, 18.0];
/// 法术施展：心魔影响（正=增加躁动，负=净化心魔）
/// 火球术+5(烈焰躁动) / 冰封术-15(冰心诀) / 雷劫术-10(以雷劫炼心) / 万剑诀-5(剑心通明) / 天地同寿-20(大道至简)
const SPELL_DEMON_EFFECT: [f32; 5] = [5.0, -15.0, -10.0, -5.0, -20.0];

pub fn realm_name(realm: i64) -> &'static str {
    REALM_NAMES.get(realm as usize).copied().unwrap_or("？？？")
}

pub fn breakthrough_price(realm: i64) -> i64 {
    BREAKTHROUGH_PILL_PRICE.get(realm as usize).copied().unwrap_or(99999)
}

pub fn breakthrough_rate(realm: i64) -> f32 {
    BREAKTHROUGH_RATE.get(realm as usize).copied().unwrap_or(0.5)
}

/// 心魔丹价格
pub fn heart_devil_pill_price(realm: i64) -> i64 {
    HEART_DEVIL_PILL_PRICE.get(realm as usize).copied().unwrap_or(99999)
}

/// 最终突破成功率 = 基础率 + 任务奖励 - 心魔惩罚（上限100%）
pub fn breakthrough_success_rate(ev: &save::EventState) -> f32 {
    let base = breakthrough_rate(ev.cultivation_realm);
    let bonus = ev.task_bonus as f32 / 100.0;
    let demon_penalty = inner_demon_breakthrough_penalty(ev.inner_demon);
    (base + bonus - demon_penalty).max(0.05).min(1.0)
}

/// 心魔对修为获取的倍率（0.4~1.0，心魔越高修为越少）
pub fn inner_demon_mult(demon: f32) -> f32 {
    if demon < 30.0 { 1.0 }
    else if demon < 60.0 { 0.8 }
    else if demon < 80.0 { 0.6 }
    else { 0.4 }
}

/// 心魔对突破成功率的惩罚（0~0.30，心魔越高越难突破）
pub fn inner_demon_breakthrough_penalty(demon: f32) -> f32 {
    if demon < 30.0 { 0.0 }
    else if demon < 60.0 { 0.10 }
    else if demon < 80.0 { 0.20 }
    else { 0.30 }
}

/// 心魔是否高到跳过续命丹直接走火入魔（≥60）
pub fn inner_demon_critical(demon: f32) -> bool {
    demon >= 60.0
}

/// 坐骑名称
pub fn mount_name(mid: i64) -> &'static str {
    MOUNT_INFO.get(mid as usize).map(|(n, _, _)| *n).unwrap_or("？？？")
}

/// 坐骑价格
pub fn mount_price(mid: i64) -> i64 {
    MOUNT_INFO.get(mid as usize).map(|(_, p, _)| *p).unwrap_or(99999)
}

/// 坐骑最低境界
pub fn mount_min_realm(mid: i64) -> i64 {
    MOUNT_INFO.get(mid as usize).map(|(_, _, r)| *r).unwrap_or(0)
}

/// 法术名称（中文）
pub fn spell_name(spell: &str) -> &'static str {
    match spell {
        "fireball" => "火球术",
        "ice" => "冰封术",
        "thunder" => "雷劫术",
        "swords" => "万剑诀",
        "armageddon" => "天地同寿",
        _ => "未知法术",
    }
}

/// 法术价格
pub fn spell_price(spell: &str) -> i64 {
    SPELL_INFO
        .iter()
        .find(|(k, _)| *k == spell)
        .map(|(_, p)| *p)
        .unwrap_or(99999)
}

/// 法术在表中的索引（0-4），找不到返回 -1
fn spell_index(spell: &str) -> isize {
    SPELL_INFO
        .iter()
        .position(|(k, _)| *k == spell)
        .map(|i| i as isize)
        .unwrap_or(-1)
}

/// 从 item 字符串提取 mount_id（"mount_sword" → 1）
fn mount_id_from_item(item: &str) -> i64 {
    match item {
        "mount_sword" => 1,
        "mount_gourd" => 2,
        "mount_dragon" => 3,
        "mount_qilin" => 4,
        "mount_phoenix" => 5,
        _ => 0,
    }
}

/// 检查是否拥有某坐骑
fn mount_owned(ev: &save::EventState, mid: i64) -> bool {
    match mid {
        1 => ev.owned_mount_sword,
        2 => ev.owned_mount_gourd,
        3 => ev.owned_mount_dragon,
        4 => ev.owned_mount_qilin,
        5 => ev.owned_mount_phoenix,
        _ => false,
    }
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
    /// 当前特殊状态（apply_sample 里更新，to_stats_payload 里读取）
    current_status: Status,
    /// 过劳变异次数镜像（从 ev.pet_variant 同步）
    current_variant: i64,
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
    // 彩蛋：存款首达500（修仙之路开启的神秘提示）
    SavingsMilestone,
    // 修仙：过劳走火入魔（体力归零时，修仙模式不走医院走这个）
    CultDeviation,
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
            current_status: Status::Normal,
            current_variant: 0,
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
            current_status: Status::Normal,
            current_variant: 0,
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
            status: self.current_status,
            pet_variant: self.current_variant,
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

        // ===== 更新当前特殊状态 + 变异次数镜像（供前端渲染）=====
        self.current_variant = ev.pet_variant;
        self.current_status = if ev.vacation_until > 0 {
            Status::Vacation
        } else if ev.leave_until > 0 {
            Status::OnLeave
        } else if self.hospital_until.is_some() {
            Status::Hospital
        } else {
            Status::Normal
        };

        // ===== 度假中检查（仅普通模式冻结数值；修仙模式照常推进）=====
        if ev.vacation_until > 0 && (now_secs as i64) < ev.vacation_until {
            if !ev.cultivation_mode {
                return events; // 普通模式还在度假，冻结
            }
            // 修仙模式：清除残留的度假状态（化凡时可能带入），不冻结
            ev.vacation_until = 0;
        }
        if ev.vacation_until > 0 && (now_secs as i64) >= ev.vacation_until {
            // 度假结束
            ev.vacation_until = 0;
            self.mood = 100.0; // 度假回来心情满
            events.push(TickEvent::VacationEnd);
        }

        // ===== 离职回归检查（仅普通模式冻结；修仙模式照常推进）=====
        if ev.leave_until > 0 && (now_secs as i64) >= ev.leave_until {
            ev.leave_until = 0;
            ev.pet_variant += 1; // 形态微变（领带色变等）
            self.mood = 70.0;    // 回归心情重置
            self.stamina = 80.0;
            events.push(TickEvent::ReturnFromLeave);
        }
        if ev.leave_until > 0 {
            if !ev.cultivation_mode {
                return events; // 普通模式还在离职期，冻结
            }
            ev.leave_until = 0; // 修仙模式清除残留离职状态
        }

        // ===== 医院检查（修仙模式不会进医院，走火入魔由过劳检查处理）=====
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
            self.stamina -= (keys_per_sec * 0.35) * dt;
            // 时薪：朝当前打字强度趋近（非单调累加）。
            // 打字快→时薪上升趋近峰值，摸鱼→下个分支回落。
            // 用 lerp 让时薪平滑跟随，避免无限上涨到离谱的数值。
            let target_wage = 30.0 + keys_per_sec * 20.0; // 1键/秒≈50, 3键/秒≈90, 5键/秒≈130
            self.hourly_wage += (target_wage - self.hourly_wage) * 0.02 * dt;
            // 存款：按当前时薪算（×60 加速，游戏化节奏）
            // 修仙模式额外 ×1.5（修仙者效率更高，减少后期攒丹的枯燥）
            let savings_mult = if ev.cultivation_mode { 1.5 } else { 1.0 };
            self.savings += self.hourly_wage * dt / 60.0 * savings_mult;
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
            // 挂机不清零专注，而是缓慢衰减（休息一下不会前功尽弃）
            self.focus_seconds = (self.focus_seconds - dt * 2.0).max(0.0);
            // 摸鱼→时薪回落（朝基线 35 趋近）
            self.hourly_wage += (35.0 - self.hourly_wage) * 0.05 * dt;
            self.idle_seconds_accum += dt; // 累计挂机时长
            // 修仙模式：打坐化解心魔（挂机每 tick -0.5，约100秒散10点）
            if ev.cultivation_mode {
                ev.inner_demon = (ev.inner_demon - 0.5 * dt).max(0.0);
            }
        } else {
            self.stamina += 0.5 * dt;
            self.mood += 0.4 * dt;
            // 不忙不闲→专注缓慢衰减
            self.focus_seconds = (self.focus_seconds - dt * 1.0).max(0.0);
            // 不忙不闲→时薪缓慢回落
            self.hourly_wage += (35.0 - self.hourly_wage) * 0.03 * dt;
            self.idle_seconds_accum += dt;
        }

        // 钳制
        self.stamina = self.stamina.clamp(0.0, 100.0);
        self.hourly_wage = self.hourly_wage.clamp(15.0, 200.0);
        self.mood = self.mood.clamp(0.0, 100.0);

        // ===== 修为积累（修仙模式专属） =====
        // 修为积累速度与灵石获取匹配：打工约5分钟满100，与攒突破丹的时间相近。
        // 聚灵符期间 ×2。
        if ev.cultivation_mode && ev.cultivation_realm < 6 {
            let boost = now_secs as i64 <= ev.spirit_boost_until;
            let mult = if boost { 2.0 } else { 1.0 } * inner_demon_mult(ev.inner_demon);
            let gain = if is_working {
                // 打工每5秒tick约+1.5修为（100修为≈5-6分钟）
                0.3 * dt * mult
            } else if is_idling {
                0.15 * dt * mult
            } else {
                0.08 * dt * mult
            };
            ev.cultivation_exp = (ev.cultivation_exp + gain).min(100.0);
        }

        // ===== 番茄钟检查 =====
        // 5 分钟持续专注即触发（原 25 分钟太难达成）
        const FOCUS_THRESHOLD: f32 = 300.0;
        if self.focus_seconds >= FOCUS_THRESHOLD {
            self.focus_seconds = 0.0;
            self.savings += 200.0; // 项目交付奖金
            self.mood = (self.mood + 15.0).min(100.0); // 交付心情大好
            // 修仙模式：交付=悟道，修为增加
            if ev.cultivation_mode && ev.cultivation_realm < 6 {
                let boost = now_secs as i64 <= ev.spirit_boost_until;
                let g = if boost { 20.0 } else { 10.0 };
                ev.cultivation_exp = (ev.cultivation_exp + g).min(100.0);
            }
            events.push(TickEvent::PomodoroComplete);
        }

        // ===== 存款首达500彩蛋（修仙之路的神秘提示，只触发一次）=====
        if !ev.savings_milestone_shown && self.savings >= 500.0 && !ev.cultivation_mode {
            ev.savings_milestone_shown = true;
            events.push(TickEvent::SavingsMilestone);
        }

        // ===== 过劳检查（修仙模式：走火入魔 / 普通模式：进医院）=====
        if self.stamina <= 0.0 {
            if ev.cultivation_mode && ev.item_life_pill > 0 && !inner_demon_critical(ev.inner_demon) {
                // 续命丹救命：消耗一颗，体力回 50（心魔≥60时无效，直接走火入魔）
                ev.item_life_pill -= 1;
                self.stamina = 50.0;
                self.mood = (self.mood + 10.0).min(100.0);
                events.push(TickEvent::LifeSaved);
            } else if ev.cultivation_mode {
                // 修仙模式过劳 → 走火入魔（积累心魔，高境界更多）
                ev.inner_demon = (ev.inner_demon + 10.0 + ev.cultivation_realm as f32 * 2.0).min(100.0);
                // 心魔≥80时惩罚加倍
                let exp_loss = if ev.inner_demon >= 80.0 { 50.0 } else { 30.0 };
                self.stamina = 30.0;
                self.mood = (self.mood - 20.0).max(0.0);
                ev.cultivation_exp = (ev.cultivation_exp - exp_loss).max(0.0);
                ev.pet_variant += 1; // 过劳变异+1（走火入魔伤身）
                events.push(TickEvent::CultDeviation);
            } else {
                // 普通模式 → 进医院
                self.hospital_until = Some(now + Duration::from_secs(300));
                ev.pet_variant += 1; // 过劳变异+1（进医院伤身）
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

        // 度假：存款>=3000（升职后继续攒够）—— 仅普通模式，修仙者不度假
        if !ev.cultivation_mode && self.savings >= 3000.0 && ev.vacation_until == 0 && ev.has_promoted {
            ev.vacation_until = (now_secs as i64) + 3 * 86400; // 3天后
            self.savings -= 1500.0; // 度假花钱
            events.push(TickEvent::VacationStart);
        }

        // 离职：每天检查心情，连续3天=0则离职 —— 仅普通模式
        // 修仙模式心情归零不离职，走火入魔由过劳检查处理
        if !ev.cultivation_mode {
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
            stamina: self.stamina,
            inner_demon: ev.inner_demon,
            qi_pill: ev.item_qi_pill,
            life_pill: ev.item_life_pill,
            spirit_talisman: ev.item_spirit_talisman,
        }
    }

    // ===== 修仙指令路径（command 调用，返回事件列表） =====

    /// 切换修仙模式。
    /// 开启前提：首次需存款 >= 500（入门券）；曾经修仙过则免费重入。
    /// 关闭（化凡）：随时可关，保留境界进度，重入不扣费。
    pub fn toggle_cultivation(
        &mut self,
        ev: &mut save::EventState,
        now_secs: u64,
    ) -> Result<Vec<CultEvent>, String> {
        let mut events = Vec::new();
        if ev.cultivation_mode {
            // 化凡：切回普通模式，保留境界进度
            ev.cultivation_mode = false;
            events.push(CultEvent::CultivationOff);
            Ok(events)
        } else {
            // 重入修仙：曾经修仙过不扣500
            if !ev.ever_cultivated {
                if self.savings < 500.0 {
                    return Err("灵石不足，入门券需要 500".into());
                }
                self.savings -= 500.0;
            }
            ev.ever_cultivated = true;
            ev.cultivation_mode = true;
            if ev.cultivation_realm == 0 {
                ev.cultivation_realm = 1; // 首次：凡人→练气
            }
            // 已修仙过的保留原境界，不重置为练气
            events.push(CultEvent::CultivationOn);
            let _ = now_secs;
            Ok(events)
        }
    }

    /// 购买道具/坐骑/法术。
    /// item 取值: 丹药(qi_pill/life_pill/spirit_talisman/breakthrough_pill)
    ///            坐骑(mount_sword/mount_gourd/mount_dragon/mount_qilin/mount_phoenix)
    ///            法术(spell_fireball/spell_ice/spell_thunder/spell_swords/spell_armageddon)
    pub fn buy_item(
        &mut self,
        ev: &mut save::EventState,
        item: &str,
        now_secs: u64,
    ) -> Result<Vec<CultEvent>, String> {
        if !ev.cultivation_mode {
            return Err("需先开启修仙模式".into());
        }
        // ===== 查价 =====
        let price = match item {
            "qi_pill" => 50,
            "life_pill" => 100,
            "spirit_talisman" => 200,
            "breakthrough_pill" => breakthrough_price(ev.cultivation_realm),
            "mount_sword" => MOUNT_INFO[1].1,
            "mount_gourd" => MOUNT_INFO[2].1,
            "mount_dragon" => MOUNT_INFO[3].1,
            "mount_qilin" => MOUNT_INFO[4].1,
            "mount_phoenix" => MOUNT_INFO[5].1,
            "spell_fireball" => SPELL_INFO[0].1,
            "spell_ice" => SPELL_INFO[1].1,
            "spell_thunder" => SPELL_INFO[2].1,
            "spell_swords" => SPELL_INFO[3].1,
            "spell_armageddon" => SPELL_INFO[4].1,
            "heart_devil_pill" => heart_devil_pill_price(ev.cultivation_realm),
            _ => return Err("未知道具".into()),
        };
        // ===== 坐骑境界门槛 + 已拥有检查 =====
        match item {
            "mount_sword" | "mount_gourd" | "mount_dragon" | "mount_qilin" | "mount_phoenix" => {
                let mid = mount_id_from_item(item);
                let (_, _, min_realm) = MOUNT_INFO[mid as usize];
                if ev.cultivation_realm < min_realm {
                    return Err(format!("境界不足，需{}以上", realm_name(min_realm)));
                }
                let owned = mount_owned(ev, mid);
                if owned {
                    return Err("已拥有此坐骑".into());
                }
            }
            "heart_devil_pill" => {
                // 心魔丹：每境界限购3个
                if ev.heart_devil_pills_used >= 3 {
                    return Err("本境界心魔丹已用完（上限3个）".into());
                }
            }
            // 法术：永久解锁，已习得则不可重复购买
            s @ ("spell_fireball" | "spell_ice" | "spell_thunder" | "spell_swords" | "spell_armageddon") => {
                let key = s.trim_start_matches("spell_");
                let already = match key {
                    "fireball" => ev.spell_fireball > 0,
                    "ice" => ev.spell_ice > 0,
                    "thunder" => ev.spell_thunder > 0,
                    "swords" => ev.spell_swords > 0,
                    "armageddon" => ev.spell_armageddon > 0,
                    _ => false,
                };
                if already {
                    return Err("已习得此法术".into());
                }
            }
            _ => {}
        }
        if (self.savings as i64) < price {
            return Err(format!("灵石不足，需要 {}", price));
        }
        self.savings -= price as f32;
        let mut events = Vec::new();
        match item {
            "qi_pill" => {
                ev.item_qi_pill += 1;
                self.stamina = (self.stamina + 50.0).min(100.0);
            }
            "life_pill" => {
                ev.item_life_pill += 1;
            }
            "spirit_talisman" => {
                ev.item_spirit_talisman += 1;
                ev.spirit_boost_until = (now_secs as i64) + 3600;
            }
            "breakthrough_pill" => {
                return self.attempt_breakthrough(ev, now_secs);
            }
            // 坐骑：标记拥有 + 自动装备
            "mount_sword" => { ev.owned_mount_sword = true; ev.equipped_mount = 1; events.push(CultEvent::MountEquipped(1)); }
            "mount_gourd" => { ev.owned_mount_gourd = true; ev.equipped_mount = 2; events.push(CultEvent::MountEquipped(2)); }
            "mount_dragon" => { ev.owned_mount_dragon = true; ev.equipped_mount = 3; events.push(CultEvent::MountEquipped(3)); }
            "mount_qilin" => { ev.owned_mount_qilin = true; ev.equipped_mount = 4; events.push(CultEvent::MountEquipped(4)); }
            "mount_phoenix" => { ev.owned_mount_phoenix = true; ev.equipped_mount = 5; events.push(CultEvent::MountEquipped(5)); }
            // 法术：永久习得（>0 表示已拥有，设为 1）
            "spell_fireball" => { ev.spell_fireball = 1; }
            "spell_ice" => { ev.spell_ice = 1; }
            "spell_thunder" => { ev.spell_thunder = 1; }
            "spell_swords" => { ev.spell_swords = 1; }
            "spell_armageddon" => { ev.spell_armageddon = 1; }
            // 心魔丹：增加突破成功率+5%，计数+1
            "heart_devil_pill" => {
                ev.heart_devil_pills_used += 1;
                // 心魔丹效果：降低25点心魔（以毒攻毒，镇压心魔）
                ev.inner_demon = (ev.inner_demon - 25.0).max(0.0);
            }
            _ => {}
        }
        events.push(CultEvent::Bought {
            item: item.to_string(),
        });
        Ok(events)
    }

    /// 装备/卸下坐骑。mount_id: 0=卸下, 1-5=装备对应坐骑。
    pub fn equip_mount(
        &mut self,
        ev: &mut save::EventState,
        mount_id: i64,
    ) -> Result<Vec<CultEvent>, String> {
        if mount_id == 0 {
            ev.equipped_mount = 0;
            return Ok(vec![CultEvent::MountUnequipped]);
        }
        if !mount_owned(ev, mount_id) {
            return Err("未拥有此坐骑".into());
        }
        ev.equipped_mount = mount_id;
        Ok(vec![CultEvent::MountEquipped(mount_id)])
    }

    /// 施展法术（永久持有，消耗体力，获得修为/时薪，触发特效）。
    /// 法术字段 >0 表示已习得（永久解锁）。施法不再消耗库存。
    pub fn cast_spell(
        &mut self,
        ev: &mut save::EventState,
        spell: &str,
    ) -> Result<Vec<CultEvent>, String> {
        if !ev.cultivation_mode {
            return Err("需先开启修仙模式".into());
        }
        let idx = spell_index(spell);
        if idx < 0 {
            return Err("未知法术".into());
        }
        let i = idx as usize;
        // 校验是否已习得
        let owned = match spell {
            "fireball" => ev.spell_fireball > 0,
            "ice" => ev.spell_ice > 0,
            "thunder" => ev.spell_thunder > 0,
            "swords" => ev.spell_swords > 0,
            "armageddon" => ev.spell_armageddon > 0,
            _ => false,
        };
        if !owned {
            return Err(format!("尚未习得{}", spell_name(spell)));
        }
        // 校验体力
        let cost = SPELL_STAMINA_COST[i];
        if self.stamina < cost {
            return Err(format!("体力不足，{}需要{:.0}体力", spell_name(spell), cost));
        }
        // 执行：消耗体力 + 获得修为/时薪（施法如工作）
        self.stamina -= cost;
        // 坐骑共鸣：骑坐骑时施法修为 ×1.5（人骑合一，灵力倍增）
        let mount_bonus = if ev.equipped_mount > 0 { 1.5 } else { 1.0 };
        let gain_exp = SPELL_GAIN_EXP[i] * mount_bonus;
        let gain_wage = SPELL_GAIN_WAGE[i];
        if ev.cultivation_realm < 6 {
            ev.cultivation_exp = (ev.cultivation_exp + gain_exp).min(100.0);
        }
        self.hourly_wage = (self.hourly_wage + gain_wage).min(200.0);
        // 法术心魔影响：每个法术有独特的心魔效果
        let demon_eff = SPELL_DEMON_EFFECT[i];
        ev.inner_demon = (ev.inner_demon + demon_eff).max(0.0).min(100.0);
        Ok(vec![CultEvent::SpellCast { spell: spell.to_string() }])
    }

    /// 完成境界任务（剧情模式）。tier: 1=完美(+8%) 2=普通(+5%) 3=勉强(+2%)
    /// 同时给予灵石奖励。demon_reduce: 剧情中"斩心魔"等选项累计降低的心魔值。
    pub fn complete_realm_task(
        &mut self,
        ev: &mut save::EventState,
        tier: i64,
        demon_reduce: f32,
    ) -> Result<Vec<CultEvent>, String> {
        if !ev.cultivation_mode {
            return Err("需先开启修仙模式".into());
        }
        if ev.realm_task_done {
            return Err("本境界任务已完成".into());
        }
        let (bonus, reward) = match tier {
            1 => (8, 500),  // 完美
            2 => (5, 300),  // 普通
            _ => (2, 150),  // 勉强
        };
        ev.task_bonus = bonus;
        ev.realm_task_done = true;
        self.savings += reward as f32;
        // 剧情中斩心魔降低心魔
        if demon_reduce > 0.0 {
            ev.inner_demon = (ev.inner_demon - demon_reduce).max(0.0);
        }
        Ok(vec![])
    }

    /// 领取日常任务奖励（灵石+修为）。reward_type: "spirit_stones" | "exp"
    /// amount 由前端根据任务定义传入。
    pub fn claim_daily_reward(
        &mut self,
        ev: &mut save::EventState,
        spirit_stones: i64,
        exp: f32,
    ) {
        self.savings += spirit_stones as f32;
        if ev.cultivation_realm < 6 {
            ev.cultivation_exp = (ev.cultivation_exp + exp).min(100.0);
        }
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
        // 最终成功率 = 基础率 + 任务奖励 + 心魔丹
        let rate = breakthrough_success_rate(ev);
        let roll: f32 = {
            let seed = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0);
            let s = seed.wrapping_mul(2654435761).wrapping_add(1);
            ((s >> 32) as f32) / (u32::MAX as f32)
        };
        let mut events = Vec::new();
        if roll < rate {
            // 突破成功：升级 + 重置任务/心魔丹
            ev.cultivation_realm += 1;
            ev.cultivation_exp = 0.0;
            ev.task_bonus = 0;
            ev.heart_devil_pills_used = 0;
            ev.realm_task_done = false;
            ev.inner_demon = 0.0; // 升境界后心魔清零
            // 突破成功恢复部分变异（修仙疗伤，但不能完全恢复）
            ev.pet_variant = ev.pet_variant.saturating_sub(1);
            if ev.cultivation_realm >= 6 {
                events.push(CultEvent::Ascension);
            } else {
                events.push(CultEvent::RealmUp(ev.cultivation_realm));
            }
        } else {
            // 走火入魔：按境界分级惩罚（低境界容错高，高境界惩罚重）
            match ev.cultivation_realm {
                1 => {
                    // 练气：修为降到50，体力不变（新手友好）
                    ev.cultivation_exp = 50.0;
                }
                2 => {
                    // 筑基：修为降到30，体力-20
                    ev.cultivation_exp = 30.0;
                    self.stamina = (self.stamina - 20.0).max(0.0);
                }
                3 => {
                    // 金丹：修为清零，体力降到30
                    ev.cultivation_exp = 0.0;
                    self.stamina = 30.0;
                }
                4 => {
                    // 元婴：修为清零，体力降到20
                    ev.cultivation_exp = 0.0;
                    self.stamina = 20.0;
                }
                _ => {
                    // 化神：修为清零，体力降到10
                    ev.cultivation_exp = 0.0;
                    self.stamina = 10.0;
                }
            }
            // 突破失败积累心魔（高境界更多）
            ev.inner_demon = (ev.inner_demon + 15.0 + ev.cultivation_realm as f32 * 3.0).min(100.0);
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
