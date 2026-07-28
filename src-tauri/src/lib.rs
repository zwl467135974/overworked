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
// - 红线 3（不抢焦点）：窗口配置在 tauri.conf.json（透明/置顶/不抢焦点）
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
use tauri::{Emitter, Manager};
use tokio::time::sleep;

/// 采样周期：5 秒（见 overworked_behavior_sensing 的低频聚合原则）。
const SAMPLE_INTERVAL: Duration = Duration::from_secs(5);

/// 内部共享状态。Mutex 是因为 tick task 和 command 都要访问 PetState。
/// 注意：BehaviorSample 和 Expression 都不含原始数值，可安全跨线程。
struct AppState {
    sensor: Mutex<StubSensor>,
    state: Mutex<PetState>,
}

/// 点击它一下 → "哎！"（MVP 必做交互，见 overworked_game_loop）。
///
/// 触发一次短暂的 Excited 表情，数值不变（避免点击刷数值破坏反差）。
#[tauri::command]
fn poke_pet(app: tauri::AppHandle, state: tauri::State<'_, AppState>) {
    if let Ok(mut s) = state.state.lock() {
        s.on_poke();
    }
    // 临时切到 Excited 表情（下次 tick 会按真实数值切回）
    let _ = app.emit("expression-changed", Expression::Excited.to_payload());
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
                    //    ExpressionPayload 含亮度/旋转/抖动等渲染指令，
                    //    体力/心情等数值仍在 engine 内部，到不了这里。
                    let _ = app_handle.emit(
                        "expression-changed",
                        expression.to_payload(),
                    );
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![poke_pet])
        .run(tauri::generate_context!())
        .expect("error while running overworked");
}
