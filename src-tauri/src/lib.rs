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
use engine::{PetState, StatsPayload, TickEvent};
use rendering_bridge::Expression;
use sensing::{BehaviorSensor, PlatformSensor};
use skin::scan_all_skins;
use tauri::async_runtime;
use tauri::menu::{ContextMenu, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager};
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

/// 显示右键菜单（PRD 三项 + 换皮肤动态子菜单）。
#[tauri::command]
fn show_context_menu(window: tauri::WebviewWindow) {
    if let Ok(menu) = state_menu(&window.app_handle()) {
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

/// 构建右键菜单（每次右键动态构建，因为皮肤列表会变）。
fn state_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let hide_1h = MenuItem::with_id(app, "hide_1h", "暂时消失 1 小时", true, None::<&str>)?;
    let fall = MenuItem::with_id(app, "fall", "掉下去", true, None::<&str>)?;
    let about = MenuItem::with_id(app, "about", "关于", true, None::<&str>)?;
    let quit = PredefinedMenuItem::quit(app, None)?;
    let sep = PredefinedMenuItem::separator(app)?;

    // 动态构建"换皮肤"子菜单：扫描 skins/ 目录
    let skins = scan_all_skins(app);
    let mut skin_submenu = SubmenuBuilder::new(app, "换皮肤");
    for skin in &skins {
        let item_id = format!("skin:{}", skin.name);
        let item = MenuItem::with_id(app, &item_id, &skin.name, true, None::<&str>)?;
        skin_submenu = skin_submenu.item(&item);
    }
    let skins_item = skin_submenu.build()?;

    // "动作预览"子菜单：手动触发任意动作看效果（开发/调试用）
    // 状态动作（切换后会持续，直到下次状态变化）
    let state_actions = ["idle", "working", "tired", "exhausted", "overworked", "nightshift", "happy", "promoted", "lunchnap", "vacation"];
    let oneshot_actions = ["poke", "drag", "walk", "jump", "leave", "return", "teambuilding", "payday"];

    let mut preview_submenu = SubmenuBuilder::new(app, "动作预览");
    // 状态动作区（用 disabled MenuItem 当分组标签）
    let label_state = MenuItem::with_id(app, "label_state", "— 状态动作 —", false, None::<&str>)?;
    preview_submenu = preview_submenu.item(&label_state);
    for a in state_actions {
        let item = MenuItem::with_id(app, format!("preview:{a}"), a, true, None::<&str>)?;
        preview_submenu = preview_submenu.item(&item);
    }
    // 一次性动作区
    let sep2 = PredefinedMenuItem::separator(app)?;
    let label_oneshot = MenuItem::with_id(app, "label_oneshot", "— 交互/生动 —", false, None::<&str>)?;
    preview_submenu = preview_submenu.item(&sep2).item(&label_oneshot);
    for a in oneshot_actions {
        let item = MenuItem::with_id(app, format!("preview:{a}"), a, true, None::<&str>)?;
        preview_submenu = preview_submenu.item(&item);
    }
    // 事件触发区（调试用：直接触发番茄钟/进医院，不用等25分钟）
    let sep3 = PredefinedMenuItem::separator(app)?;
    let label_event = MenuItem::with_id(app, "label_event", "— 事件触发 —", false, None::<&str>)?;
    let evt_pomodoro = MenuItem::with_id(app, "event:pomodoro", "番茄钟完成", true, None::<&str>)?;
    let evt_hospital = MenuItem::with_id(app, "event:hospital", "进医院", true, None::<&str>)?;
    let evt_discharge = MenuItem::with_id(app, "event:discharge", "出院", true, None::<&str>)?;
    preview_submenu = preview_submenu
        .item(&sep3)
        .item(&label_event)
        .item(&evt_pomodoro)
        .item(&evt_hospital)
        .item(&evt_discharge);
    let preview_item = preview_submenu.build()?;

    let mut builder = MenuBuilder::new(app)
        .item(&hide_1h)
        .item(&fall)
        .item(&sep)
        .item(&preview_item)
        .item(&sep)
        .item(&skins_item);

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

            // 恢复窗口位置（无存档则默认右下角）
            if let Some(win) = app.get_webview_window("main") {
                use tauri::PhysicalPosition;
                if let Some(pos) = save_store.load_window_pos() {
                    let _ = win.set_position(PhysicalPosition::new(pos.x, pos.y));
                } else {
                    // 默认右下角：根据主屏幕尺寸算
                    if let Ok(Some(monitor)) = win.primary_monitor() {
                        let sw = monitor.size().width as i32;
                        let sh = monitor.size().height as i32;
                        // 窗口 160×200，留 20px 边距
                        let x = sw - 180;
                        let y = sh - 240;
                        let _ = win.set_position(PhysicalPosition::new(x, y));
                    }
                }
            }

            // 注册 AppState（含存档）
            app.manage(AppState {
                sensor: Mutex::new(PlatformSensor::new()),
                state: Mutex::new(pet_state),
                save: Mutex::new(save_store),
            });

            // 触发连续天数更新
            if let Some(s) = app.try_state::<AppState>() {
                if let Ok(save) = s.save.lock() {
                    let _ = save.touch_streak();
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
                    let (expression, snapshot, stats, events, work_secs, idle_secs) = {
                        let mut pet = match state.state.lock() {
                            Ok(g) => g,
                            Err(e) => {
                                eprintln!("[engine] state lock poisoned: {e}");
                                continue;
                            }
                        };
                        let events = pet.apply_sample(&sample);
                        let worked = sample.key_count > 5;
                        let idled = sample.idle_seconds >= 30;
                        (
                            pet.expression(),
                            pet.to_snapshot(),
                            pet.to_stats_payload(),
                            events,
                            if worked { SAMPLE_INTERVAL.as_secs() as i64 } else { 0 },
                            if idled { SAMPLE_INTERVAL.as_secs() as i64 } else { 0 },
                        )
                    };

                    // 3. 推送：表现层渲染指令 + 数值面板（红线2 调整后）
                    let _ = app_handle.emit("expression-changed", expression.to_payload());
                    let _ = app_handle.emit("stats-update", stats);

                    // 3b. 处理事件：番茄钟/进医院/出院
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

            // 右键菜单事件路由
            let app_handle = app.handle().clone();
            app.on_menu_event(move |_handle, event| {
                let id = event.id().0.as_str();
                match id {
                    "hide_1h" => {
                        let _ = app_handle.emit("menu/hide-1h", ());
                    }
                    "fall" => {
                        let _ = app_handle.emit("menu/fall", ());
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
            skin::list_skins,
            skin::read_skin_frame,
            skin::switch_skin
        ])
        .run(tauri::generate_context!())
        .expect("error while running overworked");
}
