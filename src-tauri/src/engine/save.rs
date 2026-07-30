// Overworked 存档系统 —— 本地 SQLite 单文件
//
// 隐私红线（红线 4：本地优先）：
// - 存档【绝不存行为明细】（什么时候按了什么键、鼠标轨迹）
// - 只存聚合后的游戏数值（体力/心情）和统计（总按键数这种聚合数）
// - SQLite 是本地单文件，零上传、零同步、零账号
//
// 离线恢复：重开时按离线时长恢复体力（离线=睡觉）。

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};

/// 四属性快照（存档用中间结构，不暴露 PetState 内部字段）。
/// 红线 2 边界：这是存档层的内部结构，不对外（不通过 command 暴露给前端）。
#[derive(Debug, Clone, Copy)]
pub struct StateSnapshot {
    pub stamina: f32,
    pub hourly_wage: f32,
    pub mood: f32,
    pub savings: f32,
}

/// 窗口位置存档
#[derive(Debug, Clone, Copy)]
pub struct WindowPos {
    pub x: i32,
    pub y: i32,
}

/// 累积统计
#[derive(Debug, Clone, Default)]
pub struct Stats {
    pub total_keys: i64,
    pub total_work_seconds: i64,
    pub total_idle_seconds: i64,
    pub streak_days: i64,
    pub last_active_date: String,
}

/// 事件追踪状态（Phase 3 特殊事件用）
#[derive(Debug, Clone, Default)]
pub struct EventState {
    pub last_payday_month: i64,
    pub last_teambuilding_day: String,
    pub has_promoted: bool,
    pub mood_zero_days: i64,
    pub last_mood_day: String,
    pub vacation_until: i64,
    pub leave_until: i64,
    pub pet_variant: i64,
    pub fx_enabled: bool,
    // 修仙系统
    pub cultivation_mode: bool,        // 是否修仙模式
    pub cultivation_realm: i64,        // 境界 0-6（凡人/练气/筑基/金丹/元婴/化神/飞升）
    pub cultivation_exp: f32,          // 修为 0-100
    pub item_qi_pill: i64,             // 回气丹
    pub item_life_pill: i64,           // 续命丹
    pub item_spirit_talisman: i64,     // 聚灵符
    pub spirit_boost_until: i64,       // 聚灵符效果结束时间戳
    pub savings_milestone_shown: bool, // 存款首达500彩蛋是否已触发
    pub ever_cultivated: bool,         // 是否曾经修仙过（化凡后重入不扣500）
    // 坐骑系统（唯一拥有，bool）
    pub owned_mount_sword: bool,       // 1=飞剑
    pub owned_mount_gourd: bool,       // 2=葫芦
    pub owned_mount_dragon: bool,      // 3=龙
    pub owned_mount_qilin: bool,       // 4=麒麟
    pub owned_mount_phoenix: bool,     // 5=凤凰
    pub equipped_mount: i64,           // 当前装备坐骑编号(0=无,1-5)
    // 法术系统（计数库存，施展消耗一个）
    pub spell_fireball: i64,           // 火球术
    pub spell_ice: i64,                // 冰封术
    pub spell_thunder: i64,            // 雷劫术
    pub spell_swords: i64,             // 万剑诀
    pub spell_armageddon: i64,         // 天地同寿
}

/// 存档存储器。持 SQLite 连接，所有操作同步（SQLite 够快，无需异步）。
pub struct SaveStore {
    conn: Connection,
}

impl SaveStore {
    /// 在指定目录打开/创建存档库。
    pub fn open(dir: PathBuf) -> rusqlite::Result<Self> {
        std::fs::create_dir_all(&dir).ok();
        let db_path = dir.join("overworked.db");
        let conn = Connection::open(db_path)?;
        Self::init_db(&conn)?;
        Ok(Self { conn })
    }

    fn init_db(conn: &Connection) -> rusqlite::Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS pet_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                stamina REAL NOT NULL,
                hourly_wage REAL NOT NULL,
                mood REAL NOT NULL,
                savings REAL NOT NULL,
                last_saved INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS stats (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                total_keys INTEGER DEFAULT 0,
                total_work_seconds INTEGER DEFAULT 0,
                total_idle_seconds INTEGER DEFAULT 0,
                last_active_date TEXT,
                streak_days INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS window_pos (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                x INTEGER NOT NULL,
                y INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                last_payday_month INTEGER DEFAULT 0,
                last_teambuilding_day TEXT,
                has_promoted INTEGER DEFAULT 0,
                mood_zero_days INTEGER DEFAULT 0,
                last_mood_day TEXT,
                vacation_until INTEGER DEFAULT 0,
                leave_until INTEGER DEFAULT 0,
                pet_variant INTEGER DEFAULT 0,
                fx_enabled INTEGER DEFAULT 1,
                cultivation_mode INTEGER DEFAULT 0,
                cultivation_realm INTEGER DEFAULT 0,
                cultivation_exp REAL DEFAULT 0.0,
                item_qi_pill INTEGER DEFAULT 0,
                item_life_pill INTEGER DEFAULT 0,
                item_spirit_talisman INTEGER DEFAULT 0,
                spirit_boost_until INTEGER DEFAULT 0,
                savings_milestone_shown INTEGER DEFAULT 0,
                ever_cultivated INTEGER DEFAULT 0,
                owned_mount_sword INTEGER DEFAULT 0,
                owned_mount_gourd INTEGER DEFAULT 0,
                owned_mount_dragon INTEGER DEFAULT 0,
                owned_mount_qilin INTEGER DEFAULT 0,
                owned_mount_phoenix INTEGER DEFAULT 0,
                equipped_mount INTEGER DEFAULT 0,
                spell_fireball INTEGER DEFAULT 0,
                spell_ice INTEGER DEFAULT 0,
                spell_thunder INTEGER DEFAULT 0,
                spell_swords INTEGER DEFAULT 0,
                spell_armageddon INTEGER DEFAULT 0
            );
            INSERT OR IGNORE INTO stats (id) VALUES (1);
            INSERT OR IGNORE INTO events (id) VALUES (1);",
        )?;
        // 迁移：旧存档可能没有修仙字段，逐个 ALTER ADD COLUMN（忽略已存在错误）
        for col in [
            "cultivation_mode INTEGER DEFAULT 0",
            "cultivation_realm INTEGER DEFAULT 0",
            "cultivation_exp REAL DEFAULT 0.0",
            "item_qi_pill INTEGER DEFAULT 0",
            "item_life_pill INTEGER DEFAULT 0",
            "item_spirit_talisman INTEGER DEFAULT 0",
            "spirit_boost_until INTEGER DEFAULT 0",
            "savings_milestone_shown INTEGER DEFAULT 0",
            "ever_cultivated INTEGER DEFAULT 0",
            "owned_mount_sword INTEGER DEFAULT 0",
            "owned_mount_gourd INTEGER DEFAULT 0",
            "owned_mount_dragon INTEGER DEFAULT 0",
            "owned_mount_qilin INTEGER DEFAULT 0",
            "owned_mount_phoenix INTEGER DEFAULT 0",
            "equipped_mount INTEGER DEFAULT 0",
            "spell_fireball INTEGER DEFAULT 0",
            "spell_ice INTEGER DEFAULT 0",
            "spell_thunder INTEGER DEFAULT 0",
            "spell_swords INTEGER DEFAULT 0",
            "spell_armageddon INTEGER DEFAULT 0",
        ] {
            let sql = format!("ALTER TABLE events ADD COLUMN {col}");
            let _ = conn.execute(&sql, []); // 忽略"已存在"错误
        }
        Ok(())
    }

    /// 读取存档状态 + 离线秒数。无存档返回 None（首次启动）。
    pub fn load_state(&self) -> Option<(StateSnapshot, u64)> {
        let row: rusqlite::Result<(f64, f64, f64, f64, i64)> = self.conn.query_row(
            "SELECT stamina, hourly_wage, mood, savings, last_saved FROM pet_state WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        );
        let (stamina, wage, mood, savings, last_saved) = row.ok()?;
        let offline_secs = now_secs().saturating_sub(last_saved as u64);
        Some((
            StateSnapshot {
                stamina: stamina as f32,
                hourly_wage: wage as f32,
                mood: mood as f32,
                savings: savings as f32,
            },
            offline_secs,
        ))
    }

    /// 存四属性 + 当前时间戳。
    pub fn save_state(&self, snap: StateSnapshot) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO pet_state (id, stamina, hourly_wage, mood, savings, last_saved)
             VALUES (1, ?1, ?2, ?3, ?4, ?5)",
            params![
                snap.stamina as f64,
                snap.hourly_wage as f64,
                snap.mood as f64,
                snap.savings as f64,
                now_secs() as i64,
            ],
        )?;
        Ok(())
    }

    /// 累加统计（每次 tick 调用）。
    pub fn add_stats(&self, keys: i64, work_secs: i64, idle_secs: i64) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE stats SET
                total_keys = total_keys + ?1,
                total_work_seconds = total_work_seconds + ?2,
                total_idle_seconds = total_idle_seconds + ?3
             WHERE id = 1",
            params![keys, work_secs, idle_secs],
        )?;
        Ok(())
    }

    /// 更新连续天数。每天首次调用时 streak+1（或断签归 1）。
    pub fn touch_streak(&self) -> rusqlite::Result<()> {
        let today = today_str();
        let last: Option<String> = self
            .conn
            .query_row(
                "SELECT last_active_date FROM stats WHERE id = 1",
                [],
                |r| r.get(0),
            )
            .ok()
            .flatten();

        let new_streak = match &last {
            None => 1,
            Some(d) if d == &today => return Ok(()), // 今天已 touch
            Some(d) => {
                // 如果上次是昨天，streak+1；否则断签归 1
                if is_yesterday(d, &today) {
                    let cur: i64 = self.conn.query_row(
                        "SELECT streak_days FROM stats WHERE id = 1",
                        [],
                        |r| r.get(0),
                    )?;
                    cur + 1
                } else {
                    1
                }
            }
        };

        self.conn.execute(
            "UPDATE stats SET last_active_date = ?1, streak_days = ?2 WHERE id = 1",
            params![today, new_streak],
        )?;
        Ok(())
    }

    /// 读统计（调试/未来打工日报用）。
    #[allow(dead_code)]
    pub fn load_stats(&self) -> Stats {
        let row: rusqlite::Result<(i64, i64, i64, i64, Option<String>)> = self.conn.query_row(
            "SELECT total_keys, total_work_seconds, total_idle_seconds, streak_days, last_active_date FROM stats WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        );
        match row {
            Ok((k, w, i, s, d)) => Stats {
                total_keys: k,
                total_work_seconds: w,
                total_idle_seconds: i,
                streak_days: s,
                last_active_date: d.unwrap_or_default(),
            },
            _ => Stats::default(),
        }
    }

    /// 存窗口位置。
    pub fn save_window_pos(&self, x: i32, y: i32) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO window_pos (id, x, y) VALUES (1, ?1, ?2)",
            params![x, y],
        )?;
        Ok(())
    }

    /// 读窗口位置。
    pub fn load_window_pos(&self) -> Option<WindowPos> {
        self.conn
            .query_row(
                "SELECT x, y FROM window_pos WHERE id = 1",
                [],
                |r| Ok(WindowPos { x: r.get(0)?, y: r.get(1)? }),
            )
            .ok()
    }

    /// 读取事件追踪状态。
    pub fn load_events(&self) -> EventState {
        let row: rusqlite::Result<(i64, Option<String>, i64, i64, Option<String>, i64, i64, i64, i64, i64, i64, f64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64)> =
            self.conn.query_row(
                "SELECT last_payday_month, last_teambuilding_day, has_promoted,
                        mood_zero_days, last_mood_day, vacation_until, leave_until, pet_variant, fx_enabled,
                        cultivation_mode, cultivation_realm, cultivation_exp,
                        item_qi_pill, item_life_pill, item_spirit_talisman, spirit_boost_until,
                        savings_milestone_shown, ever_cultivated,
                        owned_mount_sword, owned_mount_gourd, owned_mount_dragon, owned_mount_qilin, owned_mount_phoenix,
                        equipped_mount,
                        spell_fireball, spell_ice, spell_thunder, spell_swords, spell_armageddon
                 FROM events WHERE id = 1",
                [],
                |r| {
                    Ok((
                        r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?,
                        r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?,
                        r.get(10)?, r.get(11)?, r.get(12)?, r.get(13)?, r.get(14)?, r.get(15)?,
                        r.get(16)?, r.get(17)?, r.get(18)?, r.get(19)?, r.get(20)?,
                        r.get(21)?, r.get(22)?, r.get(23)?, r.get(24)?, r.get(25)?,
                        r.get(26)?, r.get(27)?, r.get(28)?,
                    ))
                },
            );
        match row {
            Ok((pm, tb, hp, mzd, lmd, vu, lu, pv, fx, cm, cr, ce, iqp, ilp, ist, sbu, sms, ec,
                oms, omg, omd, omq, omph, em, sf, si, st, ss, sa)) => EventState {
                last_payday_month: pm,
                last_teambuilding_day: tb.unwrap_or_default(),
                has_promoted: hp != 0,
                mood_zero_days: mzd,
                last_mood_day: lmd.unwrap_or_default(),
                vacation_until: vu,
                leave_until: lu,
                pet_variant: pv,
                fx_enabled: fx != 0,
                cultivation_mode: cm != 0,
                cultivation_realm: cr,
                cultivation_exp: ce as f32,
                item_qi_pill: iqp,
                item_life_pill: ilp,
                item_spirit_talisman: ist,
                spirit_boost_until: sbu,
                savings_milestone_shown: sms != 0,
                ever_cultivated: ec != 0,
                owned_mount_sword: oms != 0,
                owned_mount_gourd: omg != 0,
                owned_mount_dragon: omd != 0,
                owned_mount_qilin: omq != 0,
                owned_mount_phoenix: omph != 0,
                equipped_mount: em,
                spell_fireball: sf,
                spell_ice: si,
                spell_thunder: st,
                spell_swords: ss,
                spell_armageddon: sa,
            },
            Err(_) => EventState::default(),
        }
    }

    /// 保存事件追踪状态。
    pub fn save_events(&self, ev: &EventState) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE events SET
                last_payday_month = ?1,
                last_teambuilding_day = ?2,
                has_promoted = ?3,
                mood_zero_days = ?4,
                last_mood_day = ?5,
                vacation_until = ?6,
                leave_until = ?7,
                pet_variant = ?8,
                fx_enabled = ?9,
                cultivation_mode = ?10,
                cultivation_realm = ?11,
                cultivation_exp = ?12,
                item_qi_pill = ?13,
                item_life_pill = ?14,
                item_spirit_talisman = ?15,
                spirit_boost_until = ?16,
                savings_milestone_shown = ?17,
                ever_cultivated = ?18,
                owned_mount_sword = ?19,
                owned_mount_gourd = ?20,
                owned_mount_dragon = ?21,
                owned_mount_qilin = ?22,
                owned_mount_phoenix = ?23,
                equipped_mount = ?24,
                spell_fireball = ?25,
                spell_ice = ?26,
                spell_thunder = ?27,
                spell_swords = ?28,
                spell_armageddon = ?29
             WHERE id = 1",
            params![
                ev.last_payday_month,
                if ev.last_teambuilding_day.is_empty() { None } else { Some(&ev.last_teambuilding_day) },
                ev.has_promoted as i64,
                ev.mood_zero_days,
                if ev.last_mood_day.is_empty() { None } else { Some(&ev.last_mood_day) },
                ev.vacation_until,
                ev.leave_until,
                ev.pet_variant,
                ev.fx_enabled as i64,
                ev.cultivation_mode as i64,
                ev.cultivation_realm,
                ev.cultivation_exp as f64,
                ev.item_qi_pill,
                ev.item_life_pill,
                ev.item_spirit_talisman,
                ev.spirit_boost_until,
                ev.savings_milestone_shown as i64,
                ev.ever_cultivated as i64,
                ev.owned_mount_sword as i64,
                ev.owned_mount_gourd as i64,
                ev.owned_mount_dragon as i64,
                ev.owned_mount_qilin as i64,
                ev.owned_mount_phoenix as i64,
                ev.equipped_mount,
                ev.spell_fireball,
                ev.spell_ice,
                ev.spell_thunder,
                ev.spell_swords,
                ev.spell_armageddon,
            ],
        )?;
        Ok(())
    }
}

// ===== 时间工具（不依赖 chrono，用 std + 手写日期） =====

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 今日 YYYY-MM-DD（UTC，MVP 够用，后续可换本地时区）。
fn today_str() -> String {
    format_date(days_since_epoch(now_secs()))
}

fn days_since_epoch(secs: u64) -> u64 {
    secs / 86400
}

fn format_date(days: u64) -> String {
    // 1970-01-01 起算的天数转 YYYY-MM-DD（霍纳/民用历算法）
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

/// 判断 prev 是否是 today 的前一天。
fn is_yesterday(prev: &str, today: &str) -> bool {
    // 简单做：解析两个日期，算天数差。MVP 用字符串比较近似（同月内可行）。
    // 更稳妥：转回 days_since_epoch 比较。这里解析 YYYY-MM-DD。
    let parse = |s: &str| -> Option<u64> {
        let parts: Vec<&str> = s.split('-').collect();
        if parts.len() != 3 {
            return None;
        }
        let y: i64 = parts[0].parse().ok()?;
        let m: u64 = parts[1].parse().ok()?;
        let d: u64 = parts[2].parse().ok()?;
        // 月份天数累加（不考虑闰年的2月精度，MVP 够用）
        let month_days = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
        let days = (y as u64) * 365 + month_days.get((m - 1) as usize).copied().unwrap_or(0) + d;
        Some(days)
    };
    match (parse(prev), parse(today)) {
        (Some(p), Some(t)) => t == p + 1,
        _ => false,
    }
}
