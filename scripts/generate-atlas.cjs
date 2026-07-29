// generate-atlas.js —— 生成默认占位 spritesheet
//
// 这个脚本用 node-canvas 按 pet.json 契约画出 4列×8行的占位 atlas。
// 仅开发时跑一次（node scripts/generate-atlas.js），生成 src/assets/pet-atlas.png。
// 真正的美术 atlas 替换这个文件即可，无需改代码。
//
// 占位策略：每行用不同主色调 + 像素打工仔轮廓，让状态可区分。
// 这不是最终美术，是验证 atlas 播放链路的脚手架。

const { createCanvas } = require("canvas");
const fs = require("fs");
const path = require("path");

const FW = 32; // frame width
const FH = 32; // frame height
const COLS = 4;
const ROWS = 8;

const canvas = createCanvas(COLS * FW, ROWS * FH);
const ctx = canvas.getContext("2d");
ctx.imageSmoothingEnabled = false;

// 每行的主色调（状态识别用）
const STATE_COLORS = [
  "#6b7280", // Working 灰
  "#9ca3af", // Idle 浅灰
  "#f59e0b", // Tired 橙
  "#ef4444", // Exhausted 红
  "#7f1d1d", // Overworked 暗红
  "#4c1d95", // NightShift 紫
  "#22c55e", // Excited 绿
  "#facc15", // Happy 黄
];

const SKIN = "#f1c27d";
const DARK = "#1f2937";
const WHITE = "#ffffff";

/** 在指定帧格子里画一个像素打工仔（带状态色调 + 帧序变化） */
function drawPetCell(ctx, col, row, baseColor, frame) {
  const ox = col * FW; // 格子原点 x
  const oy = row * FH;

  // 帧间动画偏移：偶数帧下移 1px（呼吸/晃动感）
  const animY = frame % 2 === 0 ? 0 : 1;

  // 身体（用状态色，区分行）
  ctx.fillStyle = baseColor;
  ctx.fillRect(ox + 10, oy + 14 + animY, 12, 12);

  // 头（肉色）
  ctx.fillStyle = SKIN;
  ctx.fillRect(ox + 11, oy + 6 + animY, 10, 8);

  // 头发
  ctx.fillStyle = DARK;
  ctx.fillRect(ox + 11, oy + 6 + animY, 10, 2);

  // 眼睛（按行/状态变化）
  const eyeY = oy + 9 + animY;
  if (row === 3) {
    // Exhausted: X 眼
    ctx.fillStyle = DARK;
    ctx.fillRect(ox + 12, eyeY, 1, 1);
    ctx.fillRect(ox + 14, eyeY, 1, 1);
    ctx.fillRect(ox + 13, eyeY + 1, 1, 1);
    ctx.fillRect(ox + 17, eyeY, 1, 1);
    ctx.fillRect(ox + 19, eyeY, 1, 1);
    ctx.fillRect(ox + 18, eyeY + 1, 1, 1);
  } else if (row === 6 || row === 7) {
    // Excited/Happy: ^ 眼
    ctx.fillStyle = DARK;
    ctx.fillRect(ox + 13, eyeY, 1, 1);
    ctx.fillRect(ox + 12, eyeY + 1, 3, 1);
    ctx.fillRect(ox + 18, eyeY, 1, 1);
    ctx.fillRect(ox + 17, eyeY + 1, 3, 1);
  } else {
    // 默认：方块眼
    ctx.fillStyle = DARK;
    ctx.fillRect(ox + 12, eyeY, 2, 2);
    ctx.fillRect(ox + 17, eyeY, 2, 2);
  }

  // 黑眼圈（NightShift/Overworked）
  if (row === 4 || row === 5) {
    ctx.fillStyle = "rgba(76,29,149,0.5)";
    ctx.fillRect(ox + 11, eyeY + 2, 4, 1);
    ctx.fillRect(ox + 16, eyeY + 2, 4, 1);
  }

  // 汗滴（Tired/Overworked）
  if (row === 2 || row === 4) {
    ctx.fillStyle = "#60a5fa";
    ctx.fillRect(ox + 20, oy + 4 + animY, 1, 2);
  }

  // zZ（NightShift，第 2/4 帧显示，制造飘动感）
  if (row === 5 && (frame === 1 || frame === 3)) {
    ctx.fillStyle = WHITE;
    ctx.fillRect(ox + 22, oy + 3, 1, 1);
    ctx.fillRect(ox + 23, oy + 2, 1, 1);
  }

  // Excited 蹦跳：奇数帧整体上移 2px（已在 animY 体现部分，这里加强）
  if (row === 6 && frame % 2 === 1) {
    // 重新画一遍上移的版本（覆盖）
    ctx.clearRect(ox, oy, FW, FH);
    const liftY = -2;
    ctx.fillStyle = baseColor;
    ctx.fillRect(ox + 10, oy + 14 + animY + liftY, 12, 12);
    ctx.fillStyle = SKIN;
    ctx.fillRect(ox + 11, oy + 6 + animY + liftY, 10, 8);
    ctx.fillStyle = DARK;
    ctx.fillRect(ox + 11, oy + 6 + animY + liftY, 10, 2);
    ctx.fillRect(ox + 13, oy + 9 + animY + liftY, 1, 1);
    ctx.fillRect(ox + 12, oy + 10 + animY + liftY, 3, 1);
    ctx.fillRect(ox + 18, oy + 9 + animY + liftY, 1, 1);
    ctx.fillRect(ox + 17, oy + 10 + animY + liftY, 3, 1);
  }
}

// 画全部 32 帧
for (let row = 0; row < ROWS; row++) {
  for (let col = 0; col < COLS; col++) {
    drawPetCell(ctx, col, row, STATE_COLORS[row], col);
  }
}

// 导出
const outPath = path.join(__dirname, "..", "src", "assets", "pet-atlas.png");
const buf = canvas.toBuffer("image/png");
fs.writeFileSync(outPath, buf);
console.log(`✅ Atlas 生成: ${outPath} (${COLS * FW}×${ROWS * FH}, ${COLS * ROWS} 帧)`);
