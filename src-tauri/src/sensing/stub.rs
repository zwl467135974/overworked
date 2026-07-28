// Overworked 行为感知 —— Stub 实现
//
// MVP 工程骨架阶段：用一个假 sensor 占位，返回循环变化的样本，
// 让整条链路（感知→状态→表情→emit）能跑起来、能验证。
//
// 等工具链验证通过后，这里替换为真实实现：
//   Windows: rdev / windows crate 全局 hook
//   macOS:   CGEventTap（需"辅助功能"权限）
//   Linux:   evdev / X11
// 替换时务必对照 overworked_behavior_sensing 的红线检查清单。

use std::time::{Instant, Duration};

use super::{BehaviorSample, BehaviorSensor};

/// 假感知器：模拟"打工 → 摸鱼 → 打工"的循环，
/// 让骨架阶段能看到表情从 Working 切到 Idle 再切回。
pub struct StubSensor {
    start: Instant,
}

impl StubSensor {
    pub fn new() -> Self {
        Self {
            start: Instant::now(),
        }
    }
}

impl Default for StubSensor {
    fn default() -> Self {
        Self::new()
    }
}

impl BehaviorSensor for StubSensor {
    fn sample_and_reset(&mut self) -> BehaviorSample {
        let elapsed = self.start.elapsed();
        // 30 秒一个周期：前 20 秒"打工"，后 10 秒"摸鱼"
        let cycle_pos = elapsed.as_secs() % 30;
        if cycle_pos < 20 {
            // 打工：模拟每秒约 4 次按键（5 秒窗口 = 20 次）
            BehaviorSample {
                key_count: 20,
                mouse_move_pixels: 300,
                mouse_click_count: 5,
                idle_seconds: 0,
            }
        } else {
            // 摸鱼：无活动，空闲 35 秒（>30 触发体力恢复）
            BehaviorSample {
                key_count: 0,
                mouse_move_pixels: 0,
                mouse_click_count: 0,
                idle_seconds: 35,
            }
        }
    }
}

// 静默 unused 警告：Duration 在 stub 里暂未用，保留 import 供真实实现复用
#[allow(dead_code)]
const _: Duration = Duration::from_secs(0);
