// Overworked 渲染桥 —— 层 3
//
// 职责：把 engine 内部的数值状态翻译成 Expression，通过 Tauri event 推给前端。
// 这是"数值不外泄"红线（红线 2）的代码执行点：
//   engine 数值 --[翻译]--> Expression --[emit]--> 前端
// 任何把原始数值塞进 emit 的代码都违反红线，会被此处类型系统挡住
// （Expression 枚举里根本没地方放数字）。

pub mod expression;

pub use expression::Expression;
