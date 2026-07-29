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

use std::sync::Mutex;
use std::time::Duration;

use engine::PetState;
use rendering_bridge::Expression;
use sensing::{BehaviorSensor, StubSensor};
use tauri::async_runtime;
use tauri::menu::{ContextMenu, MenuBuilder, MenuItem, PredefinedMenuItem};
use tauri::{Emitter, Manager};
use tokio::time::sleep;

/// 采样周期：5 秒（见 overworked_behavior_sensing 的低频聚合原则）。
const SAMPLE_INTERVAL: Duration = Duration::from_secs(5);

/// 内部共享状态。Mutex 是因为 tick task 和 command 都要访问 PetState。
struct AppState {
    sensor: Mutex<StubSensor>,
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

/// 显示右键菜单（PRD 三项：暂时消失1小时 / 关于 / 退出）。
#[tauri::command]
fn show_context_menu(window: tauri::WebviewWindow) {
    if let Ok(menu) = state_menu(&window.app_handle()) {
        // ContextMenu::popup 要 Window，WebviewWindow 通过 deref 取底层 Window
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

/// 构建右键菜单（启动时构建一次，避免每次右键重建）。
fn state_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let hide_1h = MenuItem::with_id(app, "hide_1h", "暂时消失 1 小时", true, None::<&str>)?;
    let about = MenuItem::with_id(app, "about", "关于", true, None::<&str>)?;
    let quit = PredefinedMenuItem::quit(app, None)?;
    let sep = PredefinedMenuItem::separator(app)?;

    MenuBuilder::new(app)
        .item(&hide_1h)
        .item(&sep)
        .item(&about)
        .item(&quit)
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            sensor: Mutex::new(StubSensor::new()),
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
                match event.id().0.as_str() {
                    "hide_1h" => {
                        // 触发隐藏逻辑（通过 emit 让前端 invoke，或直接操作窗口）
                        let _ = app_handle.emit("menu/hide-1h", ());
                    }
                    "about" => {
                        // 关于：不弹窗（红线 3），用产品自己的语言——冒一句文案
                        let _ = app_handle.emit(
                            "bubble-show",
                            "Overworked v0.1 — 它替你打工，你替它活着",
                        );
                    }
                    _ => {}
                }
                // quit 由 PredefinedMenuItem 自动处理，无需 match
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            poke_pet,
            set_cursor_passthrough,
            show_context_menu,
            hide_for_one_hour
        ])
        .run(tauri::generate_context!())
        .expect("error while running overworked");
}
