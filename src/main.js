// Overworked 前端 —— 桌宠像素打工仔
//
// 设计红线（见 overworked_design_principles）：
// - 前端绝不持有数值（体力/心情等），只接收后端 emit 的 Expression
// - 不弹窗、不提醒、不教育用户（红线 1）
// - Canvas 只画像素角色，数值→表情的翻译在 Rust 侧完成
//
// 当前阶段（工程骨架）：Canvas 先画占位色块，监听事件但暂不画帧动画。

const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

const canvas = document.getElementById("pet");
const ctx = canvas.getContext("2d");
// 关闭抗锯齿，保持像素感
ctx.imageSmoothingEnabled = false;

/** 后端下发的表情状态（见 rendering_bridge/expression.rs）。
 *  前端只认这个枚举字符串，永远拿不到体力/心情等数值。 */
const EXPRESSION_COLORS = {
  Working: "#6b7280", // 从容干活，灰
  Focused: "#3b82f6", // 专注（番茄钟），蓝
  Tired: "#f59e0b", // 疲惫冒汗，橙
  Exhausted: "#ef4444", // 瘫倒，红
  Overworked: "#7f1d1d", // 进医院前兆，暗红
  Idle: "#9ca3af", // 带薪摸鱼，浅灰
  NightShift: "#4c1d95", // 夜班黑眼圈，紫
  Excited: "#22c55e", // 亢奋，绿
  Chaotic: "#a855f7", // 混乱，亮紫
  Happy: "#facc15", // 庆祝，黄
};

let currentExpression = "Working";

/** 画当前表情对应的占位色块（MVP，后续换成像素帧） */
function drawPet() {
  const color = EXPRESSION_COLORS[currentExpression] || "#6b7280";
  // 清空（透明）
  ctx.clearRect(0, 0, 96, 96);
  // 画一个居中的 48×48 像素角色占位
  ctx.fillStyle = color;
  ctx.fillRect(24, 24, 48, 48);
  // 眼睛占位（两个白点 + 黑瞳）
  ctx.fillStyle = "#fff";
  ctx.fillRect(36, 38, 6, 6);
  ctx.fillRect(54, 38, 6, 6);
  ctx.fillStyle = "#000";
  ctx.fillRect(38, 40, 3, 3);
  ctx.fillRect(56, 40, 3, 3);
}

// 表情变化 → 重绘。数值永远不离开 Rust 侧。
listen("expression-changed", (event) => {
  currentExpression = event.payload;
  drawPet();
});

// 冒泡事件（MVP 先留桩，不实现 DOM 气泡）
listen("bubble-show", (event) => {
  // TODO Phase 2: 在窗口外/上方渲染 3 秒消失的冒泡文字
  console.debug("[bubble]", event.payload);
});

// 点击它一下 → "哎！"（MVP 必做交互，见 overworked_game_loop）
// 注意：因 -webkit-app-region: drag 会吞 mousedown，这里用双击触发 poke 作为占位。
// 后续会用 data-tauri-drag-region 分离拖动区与点击区来支持单击 poke。
canvas.addEventListener("dblclick", () => {
  invoke("poke_pet").catch((e) => console.error("poke failed", e));
});

// 首次绘制
drawPet();
