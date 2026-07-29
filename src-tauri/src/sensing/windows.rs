// Overworked 行为感知 —— Windows 实现
//
// 隐私红线（见 overworked_behavior_sensing，技术命门）：
// - 红线 A：rdev 回调里只做 counter.fetch_add(1)，绝不保存 key code/按键内容
// - 红线 B：无截屏
// - 红线 C：无网络请求
// 计数器用 AtomicU32，5 秒被 sample_and_reset 取走清零，无法重建输入序列。
//
// 空闲检测用 GetLastInputInfo（Win32 API，返回系统级最后输入时间）。

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use super::{BehaviorSample, BehaviorSensor};

/// Windows 行为感知器。
///
/// 在 new() 时启动 rdev 监听线程，回调里只累加原子计数器。
/// sample_and_reset() 取走并清零，返回 5 秒聚合样本。
pub struct WindowsSensor {
    key_count: Arc<AtomicU32>,
    mouse_click_count: Arc<AtomicU32>,
    mouse_move_pixels: Arc<AtomicU32>,
    last_mouse_pos: Arc<std::sync::Mutex<Option<(f64, f64)>>>,
}

impl WindowsSensor {
    pub fn new() -> Self {
        let key_count = Arc::new(AtomicU32::new(0));
        let mouse_click_count = Arc::new(AtomicU32::new(0));
        let mouse_move_pixels = Arc::new(AtomicU32::new(0));
        let last_mouse_pos = Arc::new(std::sync::Mutex::new(None::<(f64, f64)>));

        // 启动 rdev 监听线程（全局 hook）
        let kc = Arc::clone(&key_count);
        let mc = Arc::clone(&mouse_click_count);
        let mp = Arc::clone(&mouse_move_pixels);
        let lp = Arc::clone(&last_mouse_pos);

        std::thread::spawn(move || {
            if let Err(e) = rdev::listen(move |event| {
                match event.event_type {
                    rdev::EventType::KeyPress(_) => {
                        // 红线 A：只计数，不保存哪个键
                        kc.fetch_add(1, Ordering::Relaxed);
                    }
                    rdev::EventType::ButtonPress(_) => {
                        mc.fetch_add(1, Ordering::Relaxed);
                    }
                    rdev::EventType::MouseMove { x, y } => {
                        // 累加移动距离（曼哈顿距离够用）
                        let dist = if let Ok(mut guard) = lp.lock() {
                            let d = guard.map(|(lx, ly)| {
                                ((x - lx).abs() + (y - ly).abs()) as u32
                            }).unwrap_or(0);
                            *guard = Some((x, y));
                            d
                        } else {
                            0
                        };
                        if dist > 0 {
                            mp.fetch_add(dist.min(1000), Ordering::Relaxed); // 单次上限防溢出
                        }
                    }
                    _ => {}
                }
            }) {
                eprintln!("[sensing] rdev 监听失败: {e:?}");
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

impl BehaviorSensor for WindowsSensor {
    fn sample_and_reset(&mut self) -> BehaviorSample {
        // 取走并清零计数器（atomic swap）
        let key_count = self.key_count.swap(0, Ordering::Relaxed);
        let mouse_click_count = self.mouse_click_count.swap(0, Ordering::Relaxed);
        let mouse_move_pixels = self.mouse_move_pixels.swap(0, Ordering::Relaxed);

        // 系统空闲时长（GetLastInputInfo）
        let idle_seconds = get_idle_seconds();

        BehaviorSample {
            key_count,
            mouse_move_pixels,
            mouse_click_count,
            idle_seconds,
        }
    }
}

/// 用 Win32 GetLastInputInfo 获取系统空闲秒数。
fn get_idle_seconds() -> u32 {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows::Win32::System::SystemInformation::GetTickCount64;

    unsafe {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        // GetLastInputInfo 要 *mut 裸指针，返回 windows_core::BOOL
        let ok = GetLastInputInfo(&mut info);
        if ok.as_bool() {
            let now = GetTickCount64(); // 毫秒
            let last = info.dwTime as u64;
            let idle_ms = now.saturating_sub(last);
            (idle_ms / 1000) as u32
        } else {
            0
        }
    }
}

impl Default for WindowsSensor {
    fn default() -> Self {
        Self::new()
    }
}

// 抑制 last_mouse_pos 未使用警告（它通过 Arc 共享给监听线程，这里仅持有引用）
#[allow(dead_code)]
const _: fn(&WindowsSensor) = |s| {
    let _ = &s.last_mouse_pos;
};
