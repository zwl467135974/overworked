// Overworked —— 桌宠像素打工仔
//
// 三层架构入口（见 overworked_architecture）：
//   sensing (行为感知) → engine (游戏引擎) → rendering_bridge (数值→表情)
//
// 这里把三层接成一条链：
//   每 5 秒 tick：sensor.sample_and_reset() → state.apply_sample() → emit 表情
//
// 红线守护：
// - 红线 2（不暴露数值）：emit 的载荷是 ExpressionPayload（表现层渲染指令），
//   不是体力/心情数字。亮度/旋转等是"画多亮"的指令，不是游戏数值。
// - 红线 3（不抢焦点）：窗口配置在 tauri.conf.json（透明/置顶/不抢焦点）；
//   透明留白区通过 set_ignore_cursor_events 点击穿透，不挡下层窗口
// - 红线 4（本地优先）：无任何网络请求，感知层只聚合不存原始内容

mod engine;
mod rendering_bridge;
mod sensing;
mod skin;

use std::sync::Mutex;
use std::time::Duration;

use engine::save::SaveStore;
use engine::state::{
    breakthrough_price, realm_name, today_str_from_secs, weekday_from_secs, CultEvent,
};
use engine::{CultivationPayload, PetState, StatsPayload, TickEvent};
use rendering_bridge::Expression;
use sensing::{BehaviorSensor, PlatformSensor};
use skin::scan_all_skins;
use tauri::async_runtime;
use tauri::menu::{ContextMenu, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager};
use tauri::tray::TrayIconBuilder;
use tokio::time::sleep;

/// 采样周期：5 秒（见 overworked_behavior_sensing 的低频聚合原则）。
const SAMPLE_INTERVAL: Duration = Duration::from_secs(5);

/// 内部共享状态。Mutex 是因为 tick task 和 command 都要访问 PetState。
struct AppState {
    sensor: Mutex<PlatformSensor>,
    state: Mutex<PetState>,
    save: Mutex<SaveStore>,
}

/// 点击它一下 → "哎！"（MVP 必做交互）。
/// 触发一次短暂的 Excited 表情，数值不变（避免点击刷数值破坏反差）。
#[tauri::command]
fn poke_pet(app: tauri::AppHandle, state: tauri::State<'_, AppState>) {
    if let Ok(mut s) = state.state.lock() {
        s.on_poke();
    }
    let _ = app.emit("expression-changed", Expression::Excited.to_payload());
}

/// 切换点击穿透（红线 3：透明留白区不挡下层窗口）。
/// ignore=true 时整个窗口放行鼠标；前端按需在角色区动态切换。
#[tauri::command]
fn set_cursor_passthrough(window: tauri::WebviewWindow, ignore: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(ignore)
        .map_err(|e| e.to_string())
}

/// 显示右键菜单。debug=true 显示调试项（Shift+右键）。
#[tauri::command]
fn show_context_menu(app: tauri::AppHandle, window: tauri::WebviewWindow, debug: bool) {
    if let Ok(menu) = state_menu(&app, debug) {
        let _ = menu.popup(window.as_ref().window());
    }
}

/// 暂时消失 1 小时（PRD 4.2 右键菜单功能）。
/// 用 Rust 定时器而非 JS：窗口隐藏后 JS 定时器不可靠。
#[tauri::command]
fn hide_for_one_hour(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())?;
    let app = app.clone();
    async_runtime::spawn(async move {
        sleep(Duration::from_secs(3600)).await;
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
        }
    });
    Ok(())
}

/// 回位：窗口回到屏幕右下角。
#[tauri::command]
fn reset_position(window: tauri::WebviewWindow) -> Result<(), String> {
    use tauri::PhysicalPosition;
    if let Ok(Some(monitor)) = window.current_monitor() {
        let sw = monitor.size().width as i32;
        let sh = monitor.size().height as i32;
        let x = sw - 180;
        let y = sh - 240;
        window.set_position(PhysicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 投喂咖啡：体力 +30 + 心情 +10，冒泡"续命了"。
#[tauri::command]
fn feed_coffee(app: tauri::AppHandle, state: tauri::State<'_, AppState>) {
    if let Ok(mut pet) = state.state.lock() {
        pet.drink_coffee();
    }
    // emit 更新的数值
    if let Ok(pet) = state.state.lock() {
        let _ = app.emit("stats-update", pet.to_stats_payload());
    }
    let _ = app.emit("coffee-boost", ());
    let _ = app.emit("bubble-show", "续命了！咖啡因注入");
}

/// 切换特效开关（show/hide fx-overlay + emit 通知前端）。
#[tauri::command]
fn toggle_fx(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> bool {
    let new_enabled = if let Ok(mut save) = state.save.lock() {
        let mut ev = save.load_events();
        ev.fx_enabled = !ev.fx_enabled;
        let en = ev.fx_enabled;
        let _ = save.save_events(&ev);
        en
    } else {
        return false;
    };
    if let Some(fx_win) = app.get_webview_window("fx-overlay") {
        let _ = if new_enabled { fx_win.show() } else { fx_win.hide() };
    }
    let _ = app.emit("fx-toggled", new_enabled);
    new_enabled
}

/// 打开商店窗口（修仙模式专属入口）。
#[tauri::command]
fn open_shop(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(shop) = app.get_webview_window("shop") {
        // 已存在：前置显示
        let _ = shop.show();
        let _ = shop.set_focus();
    } else {
        return Err("商店窗口未注册".into());
    }
    Ok(())
}

/// 商店窗口数据载荷。
#[derive(Debug, serde::Serialize)]
struct ShopData {
    cultivation_mode: bool,
    realm: i64,
    realm_name: String,
    exp: f32,
    savings: f32,
    qi_pill: i64,
    life_pill: i64,
    spirit_talisman: i64,
    breakthrough_price: i64,
    next_realm: String,
}

/// 获取商店数据（商店窗口启动时拉取）。
#[tauri::command]
fn get_shop_data(state: tauri::State<'_, AppState>) -> ShopData {
    let (savings, ev) = {
        let pet = state.state.lock().unwrap();
        let ev = state.save.lock().map(|s| s.load_events()).unwrap_or_default();
        (pet.to_cultivation_payload(&ev).savings, ev)
    };
    ShopData {
        cultivation_mode: ev.cultivation_mode,
        realm: ev.cultivation_realm,
        realm_name: realm_name(ev.cultivation_realm).to_string(),
        exp: ev.cultivation_exp,
        savings,
        qi_pill: ev.item_qi_pill,
        life_pill: ev.item_life_pill,
        spirit_talisman: ev.item_spirit_talisman,
        breakthrough_price: breakthrough_price(ev.cultivation_realm),
        next_realm: realm_name((ev.cultivation_realm + 1).min(6)).to_string(),
    }
}

/// 购买/使用道具。item: "qi_pill"|"life_pill"|"spirit_talisman"|"breakthrough_pill"。
#[tauri::command]
fn buy_item(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    item: String,
) -> Result<(), String> {
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let cult_events = {
        let mut pet = state.state.lock().map_err(|e| e.to_string())?;
        let mut ev = state
            .save
            .lock()
            .map(|s| s.load_events())
            .map_err(|e| e.to_string())?;
        let events = pet.buy_item(&mut ev, &item, now_secs)?;
        // 存回事件追踪 + 四属性
        if let Ok(save) = state.save.lock() {
            let _ = save.save_events(&ev);
            let _ = save.save_state(pet.to_snapshot());
        }
        events
    };
    emit_cult_events(&app, &cult_events);
    // 推送更新数值给所有窗口
    push_stats_and_cult(&app, &state);
    Ok(())
}

/// 切换修仙模式（商店"开启修仙"/"切回普通"按钮）。
#[tauri::command]
fn toggle_cultivation(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let cult_events = {
        let mut pet = state.state.lock().map_err(|e| e.to_string())?;
        let mut ev = state
            .save
            .lock()
            .map(|s| s.load_events())
            .map_err(|e| e.to_string())?;
        let events = pet.toggle_cultivation(&mut ev, now_secs)?;
        if let Ok(save) = state.save.lock() {
            let _ = save.save_events(&ev);
            let _ = save.save_state(pet.to_snapshot());
        }
        events
    };
    emit_cult_events(&app, &cult_events);
    push_stats_and_cult(&app, &state);
    Ok(())
}

/// 把修仙事件 emit 给前端（main 窗口做表情/特效）。
fn emit_cult_events(app: &tauri::AppHandle, events: &[CultEvent]) {
    for ev in events {
        match ev {
            CultEvent::CultivationOn => {
                let _ = app.emit("cultivation-on", ());
                let _ = app.emit("bubble-show", "踏入修仙之路…");
            }
            CultEvent::CultivationOff => {
                let _ = app.emit("cultivation-off", ());
                let _ = app.emit("bubble-show", "还是打工踏实");
            }
            CultEvent::Bought { item } => {
                let _ = app.emit("cult-bought", item.clone());
            }
            CultEvent::RealmUp(r) => {
                // 突破是高光时刻：确保 fx-overlay 可见（即使全局关了特效）
                if let Some(fx_win) = app.get_webview_window("fx-overlay") {
                    let _ = fx_win.show();
                }
                let _ = app.emit("realm-up", *r);
                let _ = app.emit("bubble-show", format!("突破！{}", realm_name(*r)));
            }
            CultEvent::Deviation => {
                if let Some(fx_win) = app.get_webview_window("fx-overlay") {
                    let _ = fx_win.show();
                }
                let _ = app.emit("cult-deviation", ());
                let _ = app.emit("bubble-show", "走火入魔！");
            }
            CultEvent::Ascension => {
                // 飞升结局：强制开特效 + 隐藏桌宠本体
                if let Some(fx_win) = app.get_webview_window("fx-overlay") {
                    let _ = fx_win.show();
                }
                let _ = app.emit("cult-ascension", ());
                let _ = app.emit("bubble-show", "飞升！！");
            }
        }
    }
}

/// 推送四属性 + 修仙面板给所有窗口（商店购买后用）。
fn push_stats_and_cult(app: &tauri::AppHandle, state: &tauri::State<'_, AppState>) {
    let (stats, cult) = {
        let pet = state.state.lock().unwrap();
        let ev = state
            .save
            .lock()
            .map(|s| s.load_events())
            .unwrap_or_default();
        (
            pet.to_stats_payload(),
            pet.to_cultivation_payload(&ev),
        )
    };
    let _ = app.emit("stats-update", stats);
    let _ = app.emit("cultivation-update", cult);
}

/// 打工日报：返回格式化统计文本（用冒泡展示，不做复杂UI）。
#[tauri::command]
fn get_work_report(state: tauri::State<'_, AppState>) -> String {
    let save = match state.save.lock() {
        Ok(s) => s,
        Err(_) => return "打工日报读取失败".to_string(),
    };
    let stats = save.load_stats();
    let work_h = stats.total_work_seconds / 3600;
    let work_m = (stats.total_work_seconds % 3600) / 60;
    let idle_h = stats.total_idle_seconds / 3600;
    let idle_m = (stats.total_idle_seconds % 3600) / 60;
    format!(
        "打工日报：已连续 {} 天\n打工 {}小时{}分 | 摸鱼 {}小时{}分\n累计按键 {} 次",
        stats.streak_days, work_h, work_m, idle_h, idle_m, stats.total_keys
    )
}

/// 存当前窗口位置（前端拖动结束时调用）。
#[tauri::command]
fn save_window_pos(window: tauri::WebviewWindow, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    if let Ok(save) = state.save.lock() {
        let _ = save.save_window_pos(pos.x, pos.y);
    }
    Ok(())
}

/// 退出时存档：存四属性 + 窗口位置。
/// 独立函数避免闭包内的借用生命周期问题。
fn save_on_exit(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let snapshot = match state.state.lock() {
        Ok(p) => p.to_snapshot(),
        Err(_) => return,
    };
    let Ok(save) = state.save.lock() else { return };
    let _ = save.save_state(snapshot);
    if let Some(w) = app.get_webview_window("main") {
        if let Ok(pos) = w.outer_position() {
            let _ = save.save_window_pos(pos.x, pos.y);
        }
    }
    eprintln!("[save] 退出存档完成");
}

/// 构建右键菜单。debug=true 时显示调试项（动作预览/事件触发）。
fn state_menu(app: &tauri::AppHandle, debug: bool) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    // 读存款决定商店菜单标签（<500 显示「??？」保留神秘感）
    let savings = app
        .try_state::<AppState>()
        .and_then(|s| s.state.lock().ok().map(|p| p.to_snapshot().savings))
        .unwrap_or(0.0);
    let already_cult = app
        .try_state::<AppState>()
        .and_then(|s| s.save.lock().ok().map(|sv| sv.load_events().cultivation_mode))
        .unwrap_or(false);
    let shop_label = if already_cult || savings >= 500.0 {
        "商店 / 修仙"
    } else {
        "？？？"
    };

    let hide_1h = MenuItem::with_id(app, "hide_1h", "暂时消失 1 小时", true, None::<&str>)?;
    let coffee = MenuItem::with_id(app, "coffee", "投喂咖啡", true, None::<&str>)?;
    let shop = MenuItem::with_id(app, "shop", shop_label, true, None::<&str>)?;
    let reset_pos = MenuItem::with_id(app, "reset_pos", "回位", true, None::<&str>)?;
    let fall = MenuItem::with_id(app, "fall", "掉下去", true, None::<&str>)?;
    let report = MenuItem::with_id(app, "report", "打工日报", true, None::<&str>)?;
    let fx_toggle = MenuItem::with_id(app, "fx_toggle", "特效开关", true, None::<&str>)?;
    let about = MenuItem::with_id(app, "about", "关于", true, None::<&str>)?;
    let quit = PredefinedMenuItem::quit(app, None)?;
    let sep = PredefinedMenuItem::separator(app)?;

    // 换皮肤子菜单
    let skins = scan_all_skins(app);
    let mut skin_submenu = SubmenuBuilder::new(app, "换皮肤");
    for skin in &skins {
        let item_id = format!("skin:{}", skin.name);
        let item = MenuItem::with_id(app, &item_id, &skin.name, true, None::<&str>)?;
        skin_submenu = skin_submenu.item(&item);
    }
    let skins_item = skin_submenu.build()?;

    // 用户菜单基础项
    let mut builder = MenuBuilder::new(app)
        .item(&hide_1h)
        .item(&coffee)
        .item(&shop)
        .item(&reset_pos)
        .item(&fall)
        .item(&report)
        .item(&fx_toggle)
        .item(&sep)
        .item(&skins_item);

    // 调试菜单（仅 debug 模式，Shift+右键 触发）
    if debug {
        let state_actions = ["idle", "working", "tired", "exhausted", "overworked", "nightshift", "happy", "promoted", "lunchnap", "vacation"];
        let oneshot_actions = ["poke", "drag", "walk", "jump", "leave", "return", "teambuilding", "payday"];

        let mut preview_submenu = SubmenuBuilder::new(app, "动作预览");
        let label_state = MenuItem::with_id(app, "label_state", "— 状态动作 —", false, None::<&str>)?;
        preview_submenu = preview_submenu.item(&label_state);
        for a in state_actions {
            let item = MenuItem::with_id(app, format!("preview:{a}"), a, true, None::<&str>)?;
            preview_submenu = preview_submenu.item(&item);
        }
        let sep2 = PredefinedMenuItem::separator(app)?;
        let label_oneshot = MenuItem::with_id(app, "label_oneshot", "— 交互/生动 —", false, None::<&str>)?;
        preview_submenu = preview_submenu.item(&sep2).item(&label_oneshot);
        for a in oneshot_actions {
            let item = MenuItem::with_id(app, format!("preview:{a}"), a, true, None::<&str>)?;
            preview_submenu = preview_submenu.item(&item);
        }
        let sep3 = PredefinedMenuItem::separator(app)?;
        let label_event = MenuItem::with_id(app, "label_event", "— 事件触发 —", false, None::<&str>)?;
        let evt_pomodoro = MenuItem::with_id(app, "event:pomodoro", "番茄钟完成", true, None::<&str>)?;
        let evt_hospital = MenuItem::with_id(app, "event:hospital", "进医院", true, None::<&str>)?;
        let evt_discharge = MenuItem::with_id(app, "event:discharge", "出院", true, None::<&str>)?;
        preview_submenu = preview_submenu
            .item(&sep3).item(&label_event)
            .item(&evt_pomodoro).item(&evt_hospital).item(&evt_discharge);
        let preview_item = preview_submenu.build()?;

        builder = builder.item(&sep).item(&preview_item);
    }

    if !skins.is_empty() {
        builder = builder.item(&sep);
    }

    builder
        .item(&about)
        .item(&sep)
        .item(&quit)
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // ===== 存档：打开/创建 + 加载 + 离线恢复 =====
            let data_dir = app
                .path()
                .app_local_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            let save_store = match SaveStore::open(data_dir) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[save] 存档打开失败，用默认状态: {e}");
                    SaveStore::open(std::env::temp_dir()).unwrap()
                }
            };

            // 加载存档或初始化默认状态 + 离线恢复
            let pet_state = match save_store.load_state() {
                Some((snap, offline_secs)) => {
                    let mut ps = PetState::from_snapshot(snap);
                    ps.apply_offline_recovery(offline_secs);
                    eprintln!(
                        "[save] 恢复存档：离线 {} 秒（约 {:.1} 小时）",
                        offline_secs,
                        offline_secs as f32 / 3600.0
                    );
                    ps
                }
                None => {
                    eprintln!("[save] 无存档，初始化默认状态");
                    PetState::new()
                }
            };

            // 恢复窗口位置（无存档或位置在屏幕外 → 默认右下角）
            if let Some(win) = app.get_webview_window("main") {
                use tauri::PhysicalPosition;
                // 默认右下角
                let mut default_pos = || -> (i32, i32) {
                    if let Ok(Some(monitor)) = win.primary_monitor() {
                        (monitor.size().width as i32 - 180, monitor.size().height as i32 - 240)
                    } else {
                        (1740, 840)
                    }
                };
                if let Some(pos) = save_store.load_window_pos() {
                    // 校验：存的位置是否在屏幕可见范围内
                    let in_screen = if let Ok(Some(monitor)) = win.current_monitor() {
                        let mw = monitor.size().width as i32;
                        let mh = monitor.size().height as i32;
                        // 允许部分超出，但至少要有 50px 在屏幕内
                        pos.x > -150 && pos.x < mw - 50 && pos.y > -180 && pos.y < mh - 50
                    } else {
                        true // 拿不到屏幕信息就不校验
                    };
                    if in_screen {
                        let _ = win.set_position(PhysicalPosition::new(pos.x, pos.y));
                    } else {
                        // 屏幕外 → 拉回右下角
                        let (x, y) = default_pos();
                        let _ = win.set_position(PhysicalPosition::new(x, y));
                    }
                } else {
                    let (x, y) = default_pos();
                    let _ = win.set_position(PhysicalPosition::new(x, y));
                }
            }

            // ===== fx-overlay 配置（点击穿透 + 根据存档决定显示）=====
            if let Some(fx_win) = app.get_webview_window("fx-overlay") {
                let _ = fx_win.set_ignore_cursor_events(true);
                if !save_store.load_events().fx_enabled {
                    let _ = fx_win.hide();
                }
            }

            // 注册 AppState（含存档）
            app.manage(AppState {
                sensor: Mutex::new(PlatformSensor::new(app.handle().clone())),
                state: Mutex::new(pet_state),
                save: Mutex::new(save_store),
            });

            // 启动时推送一次修仙状态（让前端立即初始化境界面板，不用等 5 秒 tick）
            if let Some(s) = app.try_state::<AppState>() {
                if let (Ok(pet), Ok(save)) = (s.state.lock(), s.save.lock()) {
                    let ev = save.load_events();
                    let cult = pet.to_cultivation_payload(&ev);
                    if cult.cultivation_mode {
                        let _ = app.emit("cultivation-update", cult);
                    }
                    // 已飞升（境界 6）：桌宠已化光而去，隐藏本体
                    if cult.cultivation_mode && cult.realm >= 6 {
                        if let Some(main_win) = app.get_webview_window("main") {
                            let _ = main_win.hide();
                        }
                    }
                }
            }

            // ===== 系统托盘（红线3：不占任务栏，但用户能找到）=====
            let tray_menu = state_menu(app.handle(), false).unwrap_or_else(|_| {
                MenuBuilder::new(app).build().unwrap()
            });
            let _ = TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().cloned().unwrap())
                .tooltip("Overworked — 它替你打工")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .build(app);

            // 触发连续天数更新 + 成就检查 + 每日语录
            let now_secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            if let Some(s) = app.try_state::<AppState>() {
                if let Ok(save) = s.save.lock() {
                    let prev_active = save.load_stats().last_active_date.clone();
                    let _ = save.touch_streak();
                    let stats = save.load_stats();
                    let today = today_str_from_secs(now_secs);
                    // 每日首次启动 → 冒打工语录（按星期）
                    if prev_active != today {
                        let weekday = weekday_from_secs(now_secs);
                        let quote = match weekday {
                            1 => "周一…它已经不想动了",
                            2 => "周二，离周末还有四天，它哭了",
                            3 => "周三，它说这是最难熬的一天",
                            4 => "周四！它看到希望的曙光了",
                            5 => "周五！它已经坐不住了！",
                            6 => "周六加班？它的眼神死了",
                            _ => "周日还在用电脑…它心疼你",
                        };
                        let _ = app.emit("bubble-show", quote);
                    }
                    // 成就
                    let milestone = match stats.streak_days {
                        7 => Some("成就：连续打工 7 天！你比它还能卷"),
                        30 => Some("成就：连续打工 30 天！它已经认你做老板了"),
                        100 => Some("成就：连续打工 100 天！它是你的了"),
                        _ => None,
                    };
                    if let Some(msg) = milestone {
                        let _ = app.emit("bubble-show", msg);
                    }
                }
            }

            // 启动后台采样循环：感知 → 状态 → 表情 + 定期存档
            let app_handle = app.handle().clone();
            async_runtime::spawn(async move {
                let state = app_handle.state::<AppState>();
                let mut tick_count = 0u32;
                loop {
                    sleep(SAMPLE_INTERVAL).await;
                    tick_count += 1;

                    // 1. 感知：取走并清零计数器（5 秒聚合样本）
                    let sample = {
                        let mut sensor = match state.sensor.lock() {
                            Ok(g) => g,
                            Err(e) => {
                                eprintln!("[sensing] sensor lock poisoned: {e}");
                                continue;
                            }
                        };
                        sensor.sample_and_reset()
                    };

                    // 2. 状态：消费样本，推进四属性 + 收集事件
                    let now_secs = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    let (expression, snapshot, stats, events, work_secs, idle_secs, cult) = {
                        let mut pet = match state.state.lock() {
                            Ok(g) => g,
                            Err(e) => {
                                eprintln!("[engine] state lock poisoned: {e}");
                                continue;
                            }
                        };
                        // 读事件追踪状态，传给 apply_sample
                        let mut ev_state = match state.save.lock() {
                            Ok(s) => s.load_events(),
                            Err(_) => Default::default(),
                        };
                        let events = pet.apply_sample(&sample, &mut ev_state, now_secs);
                        // 存回事件追踪状态
                        if let Ok(save) = state.save.lock() {
                            let _ = save.save_events(&ev_state);
                        }
                        let worked = sample.key_count > 5;
                        let idled = sample.idle_seconds >= 30;
                        let cult = pet.to_cultivation_payload(&ev_state);
                        (
                            pet.expression(),
                            pet.to_snapshot(),
                            pet.to_stats_payload(),
                            events,
                            if worked { SAMPLE_INTERVAL.as_secs() as i64 } else { 0 },
                            if idled { SAMPLE_INTERVAL.as_secs() as i64 } else { 0 },
                            cult,
                        )
                    };

                    // 3. 推送
                    let _ = app_handle.emit("expression-changed", expression.to_payload());
                    let _ = app_handle.emit("stats-update", stats);
                    // 修仙模式下推送修仙面板（境界条/修为条实时更新）
                    if cult.cultivation_mode {
                        let _ = app_handle.emit("cultivation-update", cult);
                    }
                    // 周期 emit 桌宠位置给 fx-overlay（逻辑坐标，fx-overlay 自己转物理坐标）
                    if let Some(main_win) = app_handle.get_webview_window("main") {
                        if let Ok(pos) = main_win.outer_position() {
                            if let Ok(scale) = main_win.scale_factor() {
                                let _ = app_handle.emit(
                                    "pet-position",
                                    (pos.x as f64 / scale + 80.0, pos.y as f64 / scale + 100.0),
                                );
                            }
                        }
                    }

                    // 3b. 处理事件
                    for ev in &events {
                        match ev {
                            TickEvent::PomodoroComplete => {
                                let _ = app_handle.emit("pomodoro-complete", ());
                                let _ = app_handle.emit("bubble-show", "交付了！奖金到账");
                            }
                            TickEvent::HospitalAdmit => {
                                let _ = app_handle.emit("hospital-admit", ());
                                let _ = app_handle.emit("bubble-show", "不行了…需要躺一会");
                            }
                            TickEvent::HospitalDischarge => {
                                let _ = app_handle.emit("hospital-discharge", ());
                                let _ = app_handle.emit("bubble-show", "出院了…大病初愈");
                            }
                            TickEvent::LunchNap => {
                                let _ = app_handle.emit("lunch-nap", ());
                                let _ = app_handle.emit("bubble-show", "午休了…趴一会");
                            }
                            TickEvent::Payday(amount) => {
                                let _ = app_handle.emit("payday", ());
                                let _ = app_handle.emit("bubble-show", &format!("发工资了！+{}", amount));
                            }
                            TickEvent::TeamBuilding => {
                                let _ = app_handle.emit("team-building", ());
                                let _ = app_handle.emit("bubble-show", "周五团建！");
                            }
                            TickEvent::Promoted => {
                                let _ = app_handle.emit("promoted", ());
                                let _ = app_handle.emit("bubble-show", "我升职了！");
                            }
                            TickEvent::VacationStart => {
                                let _ = app_handle.emit("vacation-start", ());
                                let _ = app_handle.emit("bubble-show", "去度假啦！");
                            }
                            TickEvent::VacationEnd => {
                                let _ = app_handle.emit("vacation-end", ());
                                let _ = app_handle.emit("bubble-show", "度完假回来了");
                            }
                            TickEvent::Leave => {
                                let _ = app_handle.emit("leave-event", ());
                                let _ = app_handle.emit("bubble-show", "我不干了…再见");
                            }
                            TickEvent::ReturnFromLeave => {
                                let _ = app_handle.emit("return-from-leave", ());
                                let _ = app_handle.emit("bubble-show", "新员工报到！");
                            }
                            TickEvent::BossIncoming => {
                                let _ = app_handle.emit("boss-incoming", ());
                                let _ = app_handle.emit("bubble-show", "！！！老板来了！");
                            }
                            TickEvent::CoffeeBoost => {
                                // 由 feed_coffee command 直接处理，tick 不触发
                            }
                            TickEvent::LifeSaved => {
                                // 修仙：续命丹救命，金光护体特效
                                let _ = app_handle.emit("life-saved", ());
                                let _ = app_handle.emit("bubble-show", "续命丹救命！");
                            }
                            TickEvent::SavingsMilestone => {
                                // 存款首达500：彩蛋提示（金光特效 + 神秘冒泡）
                                let _ = app_handle.emit("savings-milestone", ());
                                let _ = app_handle.emit("bubble-show", "灵石满500…似乎触碰到了什么…右键看看？");
                                // 重建托盘菜单：「？？？」→「商店 / 修仙」
                                if let Some(tray) = app_handle.tray_by_id("main-tray") {
                                    if let Ok(menu) = state_menu(&app_handle, false) {
                                        let _ = tray.set_menu(Some(menu));
                                    }
                                }
                            }
                        }
                    }

                    // 4. 每 6 次（30 秒）存档 + 累加统计
                    if tick_count % 6 == 0 {
                        if let Ok(save) = state.save.lock() {
                            let _ = save.add_stats(
                                sample.key_count as i64 * 6, // 估算 30 秒总按键
                                work_secs * 6,
                                idle_secs * 6,
                            );
                            let _ = save.save_state(snapshot);
                        }
                    }
                }
            });

            // 窗口事件：退出存档 + 拖动结束检测（Moved debounce）
            let app_handle = app.handle().clone();
            // debounce：每次 Moved 重置一个 300ms 倒计时，到期=拖动结束
            let drag_timer: std::sync::Arc<std::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>> =
                std::sync::Arc::new(std::sync::Mutex::new(None));
            if let Some(win) = app.get_webview_window("main") {
                let drag_timer_clone = drag_timer.clone();
                win.on_window_event(move |event| {
                    match event {
                        tauri::WindowEvent::CloseRequested { .. } => {
                            save_on_exit(&app_handle);
                        }
                        tauri::WindowEvent::Moved(_) => {
                            // 拖动中：重置 debounce 倒计时
                            let ah = app_handle.clone();
                            let mut guard = match drag_timer_clone.lock() {
                                Ok(g) => g,
                                Err(_) => return,
                            };
                            if let Some(handle) = guard.take() {
                                handle.abort();
                            }
                            let task = async_runtime::spawn(async move {
                                sleep(Duration::from_millis(300)).await;
                                // 300ms 内无新 Moved = 拖动结束，通知前端
                                let _ = ah.emit("drag-ended", ());
                            });
                            *guard = Some(task);
                        }
                        _ => {}
                    }
                });
            }

            // 商店窗口：点 X 关闭时只隐藏不销毁（否则关一次就拿不到窗口了）
            if let Some(shop_win) = app.get_webview_window("shop") {
                let shop_clone = shop_win.clone();
                shop_win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close(); // 阻止销毁
                        let _ = shop_clone.hide(); // 改为隐藏，下次还能 show
                    }
                });
            }

            // 右键菜单事件路由
            let app_handle = app.handle().clone();
            app.on_menu_event(move |_handle, event| {
                let id = event.id().0.as_str();
                match id {
                    "hide_1h" => {
                        let _ = app_handle.emit("menu/hide-1h", ());
                    }
                    "coffee" => {
                        let state = app_handle.state::<AppState>();
                        if let Ok(mut pet) = state.state.lock() {
                            pet.drink_coffee();
                        }
                        if let Ok(pet) = state.state.lock() {
                            let _ = app_handle.emit("stats-update", pet.to_stats_payload());
                        }
                        let _ = app_handle.emit("coffee-boost", ());
                        let _ = app_handle.emit("bubble-show", "续命了！咖啡因注入");
                    }
                    "fall" => {
                        let _ = app_handle.emit("menu/fall", ());
                    }
                    "shop" => {
                        // 商店/彩蛋：存够500或已修仙才打开，否则弹神秘提示
                        let state = app_handle.state::<AppState>();
                        let (savings, already_cult) = {
                            let pet = state.state.lock().unwrap();
                            let ev = state.save.lock().map(|s| s.load_events()).unwrap_or_default();
                            (pet.to_snapshot().savings, ev.cultivation_mode)
                        };
                        if already_cult || savings >= 500.0 {
                            if let Some(shop_win) = app_handle.get_webview_window("shop") {
                                let _ = shop_win.show();
                                let _ = shop_win.set_focus();
                            }
                        } else {
                            // 彩蛋提示：保留神秘感
                            let need = 500 - savings as i64;
                            let msg = format!("？？？\n似乎…还差 {} 灵石才能触碰那个秘密", need.max(0));
                            let _ = app_handle.emit("bubble-show", msg);
                        }
                    }
                    "reset_pos" => {
                        if let Some(win) = app_handle.get_webview_window("main") {
                            use tauri::PhysicalPosition;
                            if let Ok(Some(monitor)) = win.current_monitor() {
                                let sw = monitor.size().width as i32;
                                let sh = monitor.size().height as i32;
                                let _ = win.set_position(PhysicalPosition::new(sw - 180, sh - 240));
                            }
                        }
                        let _ = app_handle.emit("bubble-show", "我回来了！");
                    }
                    "fx_toggle" => {
                        let state = app_handle.state::<AppState>();
                        let enabled = if let Ok(mut save) = state.save.lock() {
                            let mut ev = save.load_events();
                            ev.fx_enabled = !ev.fx_enabled;
                            let en = ev.fx_enabled;
                            let _ = save.save_events(&ev);
                            en
                        } else { false };
                        if let Some(fx_win) = app_handle.get_webview_window("fx-overlay") {
                            let _ = if enabled { fx_win.show() } else { fx_win.hide() };
                        }
                        let _ = app_handle.emit("fx-toggled", enabled);
                        let msg = if enabled { "特效已开启" } else { "特效已关闭" };
                        let _ = app_handle.emit("bubble-show", msg);
                    }
                    "report" => {
                        // 打工日报：读统计后冒泡展示
                        let state = app_handle.state::<AppState>();
                        let text = state.save.lock().map(|s| {
                            let stats = s.load_stats();
                            let work_h = stats.total_work_seconds / 3600;
                            let work_m = (stats.total_work_seconds % 3600) / 60;
                            let idle_h = stats.total_idle_seconds / 3600;
                            let idle_m = (stats.total_idle_seconds % 3600) / 60;
                            format!(
                                "连续{}天·打工{}h·按键{}",
                                stats.streak_days, work_h, stats.total_keys
                            )
                        }).unwrap_or_else(|_| "打工日报读取失败".to_string());
                        let _ = app_handle.emit("bubble-show", text);
                    }
                    "about" => {
                        let _ = app_handle.emit(
                            "bubble-show",
                            "Overworked v0.1 — 它替你打工，你替它活着",
                        );
                    }
                    _ if id.starts_with("skin:") => {
                        // 换皮肤：skin:<name>
                        let skin_name = id[5..].to_string();
                        let _ = app_handle.emit("skin-switched", &skin_name);
                    }
                    _ if id.starts_with("preview:") => {
                        let action = id[8..].to_string();
                        let _ = app_handle.emit("preview-action", &action);
                    }
                    "event:pomodoro" => {
                        // 调试：直接触发番茄钟效果
                        let state = app_handle.state::<AppState>();
                        if let Ok(mut pet) = state.state.lock() {
                            pet.trigger_pomodoro();
                        }
                        let _ = app_handle.emit("pomodoro-complete", ());
                        let _ = app_handle.emit("bubble-show", "交付了！奖金到账");
                        let _ = app_handle.emit("stats-update", {
                            let pet = state.state.lock().unwrap();
                            pet.to_stats_payload()
                        });
                    }
                    "event:hospital" => {
                        let state = app_handle.state::<AppState>();
                        if let Ok(mut pet) = state.state.lock() {
                            pet.trigger_hospital();
                        }
                        let _ = app_handle.emit("hospital-admit", ());
                        let _ = app_handle.emit("bubble-show", "不行了…需要躺一会");
                    }
                    "event:discharge" => {
                        let state = app_handle.state::<AppState>();
                        if let Ok(mut pet) = state.state.lock() {
                            pet.trigger_discharge();
                        }
                        let _ = app_handle.emit("hospital-discharge", ());
                        let _ = app_handle.emit("bubble-show", "出院了…大病初愈");
                        let _ = app_handle.emit("stats-update", {
                            let pet = state.state.lock().unwrap();
                            pet.to_stats_payload()
                        });
                    }
                    _ => {}
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            poke_pet,
            set_cursor_passthrough,
            show_context_menu,
            hide_for_one_hour,
            save_window_pos,
            get_work_report,
            toggle_fx,
            feed_coffee,
            reset_position,
            open_shop,
            get_shop_data,
            buy_item,
            toggle_cultivation,
            skin::list_skins,
            skin::read_skin_frame,
            skin::switch_skin
        ])
        .run(tauri::generate_context!())
        .expect("error while running overworked");
}
