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

use engine::PetState;
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

/// 构建右键菜单（每次右键动态构建，因为皮肤列表会变）。
fn state_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let hide_1h = MenuItem::with_id(app, "hide_1h", "暂时消失 1 小时", true, None::<&str>)?;
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
    let state_actions = ["idle", "working", "tired", "exhausted", "overworked", "nightshift", "happy"];
    let oneshot_actions = ["poke", "drag", "walk", "jump"];

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
    let preview_item = preview_submenu.build()?;

    let mut builder = MenuBuilder::new(app)
        .item(&hide_1h)
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
        .manage(AppState {
            sensor: Mutex::new(PlatformSensor::new()),
            state: Mutex::new(PetState::new()),
        })
        .setup(|app| {
            // 启动后台采样循环：感知 → 状态 → 表情
            let app_handle = app.handle().clone();
            async_runtime::spawn(async move {
                let state = app_handle.state::<AppState>();
                loop {
                    sleep(SAMPLE_INTERVAL).await;

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

                    // 2. 状态：消费样本，推进四属性
                    let expression = {
                        let mut pet = match state.state.lock() {
                            Ok(g) => g,
                            Err(e) => {
                                eprintln!("[engine] state lock poisoned: {e}");
                                continue;
                            }
                        };
                        pet.apply_sample(&sample);
                        // 3. 翻译：数值 → 表情（红线 2 的出口）
                        pet.expression()
                    };

                    // 4. 推送：表现层渲染指令到前端（不是游戏数值！）
                    let _ = app_handle.emit("expression-changed", expression.to_payload());
                }
            });

            // 右键菜单事件路由
            let app_handle = app.handle().clone();
            app.on_menu_event(move |_handle, event| {
                let id = event.id().0.as_str();
                match id {
                    "hide_1h" => {
                        let _ = app_handle.emit("menu/hide-1h", ());
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
                        // 动作预览：preview:<action>
                        let action = id[8..].to_string();
                        let _ = app_handle.emit("preview-action", &action);
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
            skin::list_skins,
            skin::read_skin_frame,
            skin::switch_skin
        ])
        .run(tauri::generate_context!())
        .expect("error while running overworked");
}
