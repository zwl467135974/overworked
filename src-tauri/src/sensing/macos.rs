// Overworked 行为感知 —— macOS 实现（骨架，待 Mac 环境验证）
//
// rdev 官方支持 macOS（底层 CGEventTap），键盘/鼠标 hook 跨平台可用。
// 本文件只需实现 macOS 特有的空闲检测。
//
// 【macOS 注意事项】
// 1. CGEventTap 需要"辅助功能"权限：用户需在 系统设置→隐私与安全→辅助功能 里授权
//    应用首次运行会触发系统权限弹窗，应用需说明"只统计频率不记录内容"
// 2. 透明窗口需 tauri.conf.json 加 macos-private-api feature
// 3. 本文件无法在 Windows 上编译验证，待 Mac 环境补充测试
//
// 隐私红线同 windows.rs：只记频率不记内容、不截屏、不上传。

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use super::{BehaviorSample, BehaviorSensor};

/// macOS 行为感知器。
/// rdev 的 listen 在 macOS 上同样工作（CGEventTap），计数逻辑与 windows.rs 相同。
pub struct MacSensor {
    key_count: Arc<AtomicU32>,
    mouse_click_count: Arc<AtomicU32>,
    mouse_move_pixels: Arc<AtomicU32>,
    last_mouse_pos: Arc<std::sync::Mutex<Option<(f64, f64)>>>,
}

impl MacSensor {
    pub fn new() -> Self {
        let key_count = Arc::new(AtomicU32::new(0));
        let mouse_click_count = Arc::new(AtomicU32::new(0));
        let mouse_move_pixels = Arc::new(AtomicU32::new(0));
        let last_mouse_pos = Arc::new(std::sync::Mutex::new(None::<(f64, f64)>));

        let kc = Arc::clone(&key_count);
        let mc = Arc::clone(&mouse_click_count);
        let mp = Arc::clone(&mouse_move_pixels);
        let lp = Arc::clone(&last_mouse_pos);

        // rdev 在 macOS 上用 CGEventTap，需辅助功能权限
        std::thread::spawn(move || {
            if let Err(e) = rdev::listen(move |event| {
                match event.event_type {
                    rdev::EventType::KeyPress(_) => {
                        kc.fetch_add(1, Ordering::Relaxed);
                    }
                    rdev::EventType::ButtonPress(_) => {
                        mc.fetch_add(1, Ordering::Relaxed);
                    }
                    rdev::EventType::MouseMove { x, y } => {
                        let dist = if let Ok(mut guard) = lp.lock() {
                            let d = guard.map(|(lx, ly)| {
                                ((x - lx).abs() + (y - ly).abs()) as u32
                            }).unwrap_or(0);
                            *guard = Some((x, y));
                            d
                        } else { 0 };
                        if dist > 0 {
                            mp.fetch_add(dist.min(1000), Ordering::Relaxed);
                        }
                    }
                    _ => {}
                }
            }) {
                eprintln!("[sensing] rdev macOS 监听失败（需辅助功能权限？）: {e:?}");
            }
        });

        Self {
            key_count,
            mouse_click_count,
            mouse_move_pixels,
            last_mouse_pos: Arc::clone(&last_mouse_pos),
        }
    }
}

impl BehaviorSensor for MacSensor {
    fn sample_and_reset(&mut self) -> BehaviorSample {
        let key_count = self.key_count.swap(0, Ordering::Relaxed);
        let mouse_click_count = self.mouse_click_count.swap(0, Ordering::Relaxed);
        let mouse_move_pixels = self.mouse_move_pixels.swap(0, Ordering::Relaxed);
        let idle_seconds = get_idle_seconds_macos();

        BehaviorSample {
            key_count,
            mouse_move_pixels,
            mouse_click_count,
            idle_seconds,
        }
    }
}

/// macOS 空闲检测：用 CoreGraphics 的 CGEventSourceSecondsSinceLastEventType。
/// TODO: 待 Mac 环境实现。用 core-graphics crate 或 objc。
fn get_idle_seconds_macos() -> u32 {
    // 实现方案（待验证）：
    // use core_graphics::event::CGEventSource;
    // let src = CGEventSource::new(CGEventSourceStateID::CombinedSessionState);
    // let idle = src.seconds_since_last_type(CGEventType::Null);
    // idle as u32
    //
    // 或用 objc 调 CoreGraphics C API：
    // extern "C" { fn CGEventSourceSecondsSinceLastEventType(...) -> f64; }
    0 // 占位：未实现，不触发空闲检测
}

impl Default for MacSensor {
    fn default() -> Self {
        Self::new()
    }
}

#[allow(dead_code)]
const _: fn(&MacSensor) = |s| { let _ = &s.last_mouse_pos; };
