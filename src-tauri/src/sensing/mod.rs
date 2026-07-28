// Overworked 行为感知层 —— 层 1
//
// 隐私红线（见 overworked_behavior_sensing，项目技术命门）：
// - 红线 A：绝不记录按键内容，只统计计数
// - 红线 B：绝不截屏
// - 红线 C：绝不上传
//
// 本层的唯一输出是 BehaviorSample —— 一个聚合样本。
// 审视它的每个字段：没有任何一个能还原出"用户按了什么、看了什么"。
// 这是红线 A/B/C 的代码体现。

pub mod stub;

pub use stub::StubSensor;

/// 5 秒行为样本。所有字段都是聚合值，无法还原用户原始输入。
#[derive(Debug, Clone, Default)]
pub struct BehaviorSample {
    /// 窗口内按键总数。**不含 which key**（红线 A）。
    pub key_count: u32,
    /// 窗口内鼠标移动距离（像素）。
    pub mouse_move_pixels: u32,
    /// 窗口内鼠标点击次数。
    pub mouse_click_count: u32,
    /// 本窗口末尾的系统空闲秒数。判断挂机/摸鱼用。
    pub idle_seconds: u32,
    // 注意：不存 active_app。窗口标题感知默认关闭，
    // 开启后也只存分类标签且走独立结构（Phase 2+）。
}

/// 行为感知器接口。各平台各写一个实现，通过 cfg(target_os) 切换。
///
/// 引擎每 5 秒调用一次 sample_and_reset，取走并清零内部计数器。
/// 计数器只活 5 秒 —— 高频原始信号无法被重建（兼顾隐私与性能）。
pub trait BehaviorSensor: Send {
    fn sample_and_reset(&mut self) -> BehaviorSample;
}
