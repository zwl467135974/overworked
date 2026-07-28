// Overworked 渲染桥 —— 数值 → 表情 → 表现参数 的翻译层
//
// 设计红线 2（不暴露数值）：体力/心情/存款等游戏数值绝不出现在这里。
// 这里的 ExpressionPayload 携带的是【表现层渲染指令】（亮度/旋转/抖动），
// 不是游戏数值——亮度 0.7 不等于体力 70，它是告诉前端"画暗一点"的指令。
// 红线 2 守的是"不暴露体力/心情/存款"，表现层参数不受此限。
//
// 这样设计的好处：表情的"视觉调性"集中在一处定义（这里），
// 前端只管"按参数渲染"，无需自己猜每个表情该长什么样。
// 未来调表情的视觉风格，只改这里，前端零改动。

use serde::Serialize;

/// 像素打工仔的表情/姿态（语义层，不变）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // MVP 阶段未必所有变体都用上，Phase 2+ 会补
pub enum Expression {
    Working,
    Focused,
    Tired,
    Exhausted,
    Overworked,
    Idle,
    NightShift,
    Excited,
    Chaotic,
    Happy,
}

impl Expression {
    /// 表情名（调试用，前端主要消费 payload）。
    pub fn as_str(&self) -> &'static str {
        match self {
            Expression::Working => "Working",
            Expression::Focused => "Focused",
            Expression::Tired => "Tired",
            Expression::Exhausted => "Exhausted",
            Expression::Overworked => "Overworked",
            Expression::Idle => "Idle",
            Expression::NightShift => "NightShift",
            Expression::Excited => "Excited",
            Expression::Chaotic => "Chaotic",
            Expression::Happy => "Happy",
        }
    }

    /// 翻译成前端可渲染的表现参数。
    /// 这是"一张图变桌宠"静态档的核心：同一张图，靠特效传达 10 种状态。
    pub fn to_payload(self) -> ExpressionPayload {
        match self {
            // 从容干活：原图，正常显示
            Expression::Working => ExpressionPayload {
                expression: "Working",
                brightness: 1.0,
                rotation: 0.0,
                opacity: 1.0,
                tint: None,
                bounce: BounceKind::None,
            },
            // 专注：蓝色冷色调 + 静止（聚精会神）
            Expression::Focused => ExpressionPayload {
                expression: "Focused",
                brightness: 1.0,
                rotation: 0.0,
                opacity: 1.0,
                tint: Some(BLUE),
                bounce: BounceKind::None,
            },
            // 疲惫：亮度降到 70% + 缓慢呼吸（撑不住）
            Expression::Tired => ExpressionPayload {
                expression: "Tired",
                brightness: 0.7,
                rotation: 0.0,
                opacity: 0.9,
                tint: None,
                bounce: BounceKind::Slow,
            },
            // 瘫倒：旋转 90°（躺平）+ 灰度（第一个传播点）
            Expression::Exhausted => ExpressionPayload {
                expression: "Exhausted",
                brightness: 0.6,
                rotation: 1.5708, // PI/2，躺平
                opacity: 0.8,
                tint: Some(GRAY),
                bounce: BounceKind::None,
            },
            // 进医院前兆：红色色调 + 上下抖动（快不行了）
            Expression::Overworked => ExpressionPayload {
                expression: "Overworked",
                brightness: 0.8,
                rotation: 0.0,
                opacity: 1.0,
                tint: Some(RED),
                bounce: BounceKind::Fast,
            },
            // 带薪摸鱼：半透明 + 缓慢呼吸缩放（魂都不在了）
            Expression::Idle => ExpressionPayload {
                expression: "Idle",
                brightness: 0.9,
                rotation: 0.0,
                opacity: 0.5,
                tint: None,
                bounce: BounceKind::Slow,
            },
            // 夜班：蓝紫色调（黑眼圈氛围）
            Expression::NightShift => ExpressionPayload {
                expression: "NightShift",
                brightness: 0.75,
                rotation: 0.0,
                opacity: 1.0,
                tint: Some(PURPLE),
                bounce: BounceKind::Slow,
            },
            // 亢奋：亮度 120% + 快速跳动（被 poke 或产能爆表）
            Expression::Excited => ExpressionPayload {
                expression: "Excited",
                brightness: 1.2,
                rotation: 0.0,
                opacity: 1.0,
                tint: None,
                bounce: BounceKind::Fast,
            },
            // 多线程混乱：轻微随机抖动（眼神涣散）
            Expression::Chaotic => ExpressionPayload {
                expression: "Chaotic",
                brightness: 0.95,
                rotation: 0.0,
                opacity: 1.0,
                tint: None,
                bounce: BounceKind::Random,
            },
            // 庆祝：黄色暖色调 + 缩放脉动（项目交付）
            Expression::Happy => ExpressionPayload {
                expression: "Happy",
                brightness: 1.15,
                rotation: 0.0,
                opacity: 1.0,
                tint: Some(YELLOW),
                bounce: BounceKind::Slow,
            },
        }
    }
}

/// 抖动模式。前端按此选择抖动的频率/幅度算法。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BounceKind {
    /// 静止
    None,
    /// 缓慢呼吸（~2 秒一个周期，小幅度）
    Slow,
    /// 快速跳动（~0.3 秒一个周期，大幅度）
    Fast,
    /// 随机抖动（混乱感）
    Random,
}

/// RGB 叠加色调。前端用 globalCompositeOperation 或 filter 实现。
/// 用元组而非枚举，方便前端直接当 RGB 用。
#[allow(dead_code)]
mod tint {
    pub const GRAY: (u8, u8, u8) = (120, 120, 120);
    pub const RED: (u8, u8, u8) = (200, 60, 60);
    pub const BLUE: (u8, u8, u8) = (80, 130, 220);
    pub const PURPLE: (u8, u8, u8) = (110, 70, 180);
    pub const YELLOW: (u8, u8, u8) = (220, 200, 80);
}
use tint::*;

/// 下发给前端的表现层载荷。
///
/// 【红线 2 边界说明】这些字段都是渲染指令，不是游戏数值：
/// - brightness/opacity 是"画多亮/多透明"，不是体力百分比
/// - rotation 是"画成什么角度"，不是某个属性值
/// - tint 是"叠加什么颜色"，不携带任何状态数字
/// 真正的游戏数值（体力/心情/存款）在 engine 内部，永远到不了这里。
#[derive(Debug, Clone, Copy, Serialize)]
pub struct ExpressionPayload {
    /// 表情名（调试/日志用，前端主要消费下面的参数）
    pub expression: &'static str,
    /// 亮度倍数（0.0-1.5）。1.0 = 原图。
    pub brightness: f32,
    /// 旋转弧度。0 = 正立，PI/2 = 躺平。
    pub rotation: f32,
    /// 不透明度（0.0-1.0）。
    pub opacity: f32,
    /// 叠加色调（None = 不叠色）。
    pub tint: Option<(u8, u8, u8)>,
    /// 抖动模式。
    pub bounce: BounceKind,
}
