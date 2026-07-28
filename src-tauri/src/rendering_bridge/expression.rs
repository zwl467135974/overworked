// Overworked 渲染桥 —— 数值 → 表情 的翻译层
//
// 设计红线 2（不暴露数值）：这是 Rust 侧唯一对前端暴露的状态。
// 体力/心情/存款等数值绝不出现在这里，也不通过任何 command 传给前端。
// 前端只认下面这个枚举，根据表情画像素动画。
//
// 必须与前端 src/main.js 的 EXPRESSION_COLORS 保持同步（字符串一致）。

/// 像素打工仔的表情/姿态。后端 emit("expression-changed", payload) 的载荷。
///
/// 注意：这里没有任何数字。所有"体力=12"都已在 engine 内被翻译成
/// 某个 Expression 变体，前端永远拿不到 12。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // MVP 阶段未必所有变体都用上，Phase 2+ 会补
pub enum Expression {
    /// 从容干活（体力充足）
    Working,
    /// 专注中（番茄钟进行时）
    Focused,
    /// 疲惫冒汗（体力下降）
    Tired,
    /// 瘫倒（体力见底）
    Exhausted,
    /// 进医院前兆（连续过劳）
    Overworked,
    /// 带薪摸鱼（挂机）
    Idle,
    /// 夜班（凌晨 1-5 点），黑眼圈
    NightShift,
    /// 亢奋（产能极高）
    Excited,
    /// 多线程混乱，眼神涣散
    Chaotic,
    /// 庆祝（项目交付等）
    Happy,
}

impl Expression {
    /// 序列化为前端约定的字符串。
    /// 不用 serde derive，是为了让枚举值与前端 EXACT 字符串对应、可读。
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
}
