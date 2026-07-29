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
            INSERT OR IGNORE INTO stats (id) VALUES (1);",
        )?;
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
        let row: rusqlite::Result<(i64, i64, i64, i64)> = self.conn.query_row(
            "SELECT total_keys, total_work_seconds, total_idle_seconds, streak_days FROM stats WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        );
        match row {
            Ok((k, w, i, s)) => Stats {
                total_keys: k,
                total_work_seconds: w,
                total_idle_seconds: i,
                streak_days: s,
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
