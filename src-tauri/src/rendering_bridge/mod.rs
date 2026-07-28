// Overworked 渲染桥 —— 层 3
//
// 职责：把 engine 内部的数值状态翻译成 ExpressionPayload（表现层渲染指令），
// 通过 Tauri event 推给前端。
//
// 这是"数值不外泄"红线（红线 2）的代码执行点：
//   engine 数值 --[翻译]--> Expression --[to_payload]--> ExpressionPayload --[emit]--> 前端
// 整条链路里没有任何游戏数值（体力/心情/存款）能流到前端。
// ExpressionPayload 里的亮度/旋转等是【渲染指令】，不是游戏数值。

pub mod expression;

pub use expression::{BounceKind, Expression, ExpressionPayload};
