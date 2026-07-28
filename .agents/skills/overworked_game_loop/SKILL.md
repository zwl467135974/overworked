---
name: overworked_game_loop
description: Use when designing or changing Overworked's core gameplay — the behavior-to-state loop, the four hidden stats (stamina/hourly-wage/mood/savings), state transitions, special events (overwork/hospital/night-shift/idle), behavior→state mapping, or writing bubble/吐槽 copy. This skill owns the core fun. Also load when proposing a new event, animation trigger, or pet reaction, to keep it inside the design red-lines (no nagging, no exposed numbers, contrast is king).
---

# Overworked 游戏循环规范（核心乐趣）

## 功能概述

这是 Overworked 的"游戏"部分：你的行为怎么变成它的命运。这个 skill 守的是**核心循环、四属性状态机、行为映射、冒泡文案**——也就是项目的核心乐趣所在。

先确认：任何玩法设计都已过 `overworked_design_principles` 的五条红线。

## 核心循环

```
你正常用电脑（打字/移动鼠标/切窗口/专注/熬夜/挂机）
        ↓
sensing 层每 5 秒产出 BehaviorSample
        ↓
engine 消费样本 → 更新四属性
        ↓
属性跨越阈值 → 触发事件 / 改变 Expression
        ↓
rendering-bridge 把 Expression 推给前端
        ↓
它做出反应（冒泡/瘫倒/亢奋/渡劫）
        ↓
你看到反应 → 产生情绪（好笑/心酸/愧疚）→ 调整行为
```

**关键：你永远不需要"专门去操作它"。** 它是反应性的，不是交互式的。

## 四属性状态机（内部数值，绝不外泄）

这四个属性**只存在于 Rust 引擎内部**，前端永远拿不到（红线 2）。前端只能拿到它们映射出的 `Expression`。

| 属性 | 范围 | 行为驱动 | 归零/触底后果 |
|---|---|---|---|
| **体力** Stamina | 0-100 | 打字/专注消耗，挂机/休息恢复 | 归零 → "进医院"（强制停摆 1 小时） |
| **时薪** HourlyWage | 浮动 | 专注高时薪涨，摸鱼时薪掉 | 无触底，纯波动 |
| **心情** Mood | 0-100 | 过劳/熬夜/混乱降，番茄钟/大任务/摸鱼恢复 | 归零 → "摆烂"（不干活） |
| **存款** Savings | 累积 | 时薪 × 有效工时 | 攒够阈值 → "消失去旅游"几天 |

### 数值 → 表情 的映射原则

**不在线性映射，在区间映射。** 数值是连续的，但表情是离散的姿态。例：

```
Stamina 100-70  → Working（从容干活）
Stamina  70-40  → Tired（开始冒汗）
Stamina  40-15  → Exhausted（动作迟缓）
Stamina  15-0   → 进医院前兆（脸色发青）
Stamina  = 0    → 强制停摆事件
```

**绝不做的事**：把 `Stamina=47` 这种数字传给前端让它去画进度条。数值到表情的翻译必须留在 Rust 侧（见 `overworked_architecture` 的 rendering-bridge）。

## 行为 → 状态映射（MVP 核心）

这张表是玩法设计的锚点，新增映射时对照它的"反差感"调性：

| 你的真实行为 | 状态变化 | 它的反应（Expression + 冒泡） |
|---|---|---|
| 噼里啪啦打字 2 小时 | 产能高，时薪涨，体力下降 | Excited + "需求好急" |
| 专注 25 分钟不切窗口 | 打赢一场"小怪"（番茄钟） | Focused → Happy + 掉装备 |
| 频繁切窗口、乱点 | 多线程，混乱度上升 | Chaotic + 头冒问号 |
| 挂机 30 分钟不动 | 带薪摸鱼，体力恢复 | Idle + 偶尔翻白眼 |
| 凌晨 1-5 点还在用 | 夜班，双倍产能但受伤 | NightShift + "zzZ" 还在干活 |
| 连续 3 天高强度 | 过劳，体力见底 | Overworked + 可能进医院 |
| 整理窗口/关程序 | 清理工位，心情回升 | （Phase 2）吹口哨擦桌子 |
| 长时段专注结束 | 项目交付，存款暴涨 | Happy 蹦起撒花 → 立刻 Exhausted 瘫倒 |

## MVP 必做 vs 不做

### ✅ MVP 必做（PRD 6.2）

- 体力系统（打字消耗、挂机恢复）
- 3 种基础表情：Working / Tired / Exhausted（瘫倒）
- 熬夜检测（凌晨 1-5 点 → NightShift）
- 冒泡文案 5-10 条模板，随机触发
- 瘫倒动画（体力归零触发）—— **第一个传播点**

### ❌ MVP 明确不做

- 装备/技能树
- 特殊事件（离职/团建/发工资）—— Phase 2-3
- 多角色
- LLM 生成文案
- 窗口标题感知

## 冒泡文案规范（反差是灵魂）

冒泡是"反差向"调性的主载体。写文案时记牢：

| 原则 | ❌ 反例 | ✅ 正解 |
|---|---|---|
| 不爹味（红线 1） | "你该休息了" | "需求好急" |
| 是它在打工，不是它在教育 | "今日专注不足" | "甲方又改需求了" |
| 心酸 > 正确 | "完成一个番茄钟！" | "打赢一只小怪，掉了个像素汉堡" |
| 3 秒消失，不打断 | 长篇大论 | 短句、口语、可截图 |

**MVP 文案池参考**（5-10 条起）：
- 产能高："需求好急" / "这个 bug 改不完" / "再撑一下"
- 摸鱼："带薪摸鱼" / "老板没在看" / "我瘫一会儿"
- 夜班："zzZ" / "夜班双倍，值了" / "天怎么亮了"
- 过劳：（不冒泡，靠 Overworked 表情 + 脸色发青传达）
- 项目交付："交付了！" / "终于能睡了"

文案要**可截图、可发群**——这是冷启动的社交货币（PRD 成功标准：3 人试用，≥2 人主动截图）。

## 事件触发（MVP 只做基础，Phase 2+ 扩展）

| 事件 | 触发条件 | MVP? |
|---|---|---|
| 瘫倒 | Stamina 归零 | ✅ |
| 夜班 | 凌晨 1-5 点 + 有活动 | ✅ |
| 番茄钟完成 | 连续 25 分钟专注不切窗 | 🟡 Phase 2 |
| 进医院 | 连续 3 天过劳 | Phase 2 |
| 离职/升职/团建/发工资 | 各自条件 | Phase 3 |

新增事件时，先过 `overworked_design_principles` 的过滤器（尤其红线 5：反差是灵魂）。

## 数值不可外泄的代码契约

```rust
// engine 内部持有数值
pub struct PetState {
    stamina: f32,       // 0.0 - 100.0，只存在这里
    hourly_wage: f32,
    mood: f32,
    savings: f32,
}

impl PetState {
    /// 对外只暴露表情视图，不暴露任何数字
    pub fn expression(&self) -> Expression {
        // 数值 → 表情的翻译留在这里
    }
}
// 永远不写 pub fn stamina(&self) -> f32 这种方法
```

## 与其他 skill 的关系

- 行为样本从哪来 → `overworked_behavior_sensing`
- 数值/表情怎么越过前后端边界（答案：不越界，只传表情） → `overworked_architecture`
- 任何玩法是否违背灵魂 → `overworked_design_principles`

## 检查清单

- [ ] 新增的玩法/事件过了五条红线（尤其红线 5 反差）
- [ ] 冒泡文案不爹味、短、可截图
- [ ] 没有把任何原始数值（stamina/mood/…）暴露给前端
- [ ] 数值 → 表情 的映射在 Rust 侧完成
- [ ] 新事件有明确的"行为触发条件"，不是凭空触发
- [ ] MVP 范围内的功能没有越界做 Phase 2+ 的东西
