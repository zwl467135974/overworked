// generate-skin.cjs —— 生成 default 皮肤（64×64 画布，18 动作）
//
// 输出：skins/default/<动作>/1.png 2.png ...
// 64×64 像素，比 32×32 给美术更大创作空间。
//
// 设计原则：
// - chibi 比例（大头小身）
// - 眉毛 + 嘴传达情绪（眼睛辅助）
// - 深色轮廓线 + 3 级色阶
// - 萌惨反差：圆脸大眼(萌) × 八字眉下垂嘴(惨)
//
// 用法：node scripts/generate-skin.cjs

const { createCanvas } = require("canvas");
const fs = require("fs");
const path = require("path");

const FW = 64;
const FH = 64;

// 配色（3 级色阶 ramp + 轮廓 + 强调）
const C = {
  outline: "#1a1f29",
  skin: "#f1c27d",
  skinShadow: "#d9a55c",
  hair: "#3a2e25",
  hairLight: "#5a4636",
  shirtLight: "#6b7480",
  shirt: "#4b5563",
  shirtShadow: "#2d333f",
  tie: "#c2410c",
  tieShadow: "#7c2d12",
  badge: "#fef3c7",
  dark: "#1a1f29",
  white: "#ffffff",
  sweat: "#60a5fa",
  blush: "rgba(244,114,182,0.7)",
  darkCircle: "rgba(76,29,149,0.5)",
  gold: "#fbbf24",
};

// 像素绘制工具（带轮廓）
function px(ctx, x, y, w, h, color) {
  ctx.fillStyle = C.outline;
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}
// 色阶块（亮顶/中/暗右下）
function pxRamp(ctx, x, y, w, h, light, mid, shadow) {
  ctx.fillStyle = C.outline;
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = mid;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = shadow;
  ctx.fillRect(x + w - 3, y, 3, h);
  ctx.fillRect(x, y + h - 2, w, 2);
  ctx.fillStyle = light;
  ctx.fillRect(x, y, w, 2);
}

/**
 * 画一帧像素打工仔（正面，64×64 画布）。
 * 角色居中，约占 44×52（留边距）。
 */
function drawPet(ctx, ox, oy, opts) {
  const {
    bodyDy = 0, headDy = 0,
    eyeMode = "normal", eyebrowMode = "none",
    mouthMode = "neutral",
    showSweat = false, showBlush = false, showDarkCircle = false, showZZ = false,
    lean = 0, armRaise = false, slouch = 0,
    glasses = false, // 度假墨镜
    holdingBox = false, // 搬箱子
  } = opts;

  const cx = ox + 32; // 画布中心

  // ===== 身体（衬衫）=====
  const bodyW = 22, bodyH = 20;
  const bodyX = cx - bodyW / 2 + lean;
  const bodyY = oy + 30 + bodyDy + slouch;
  pxRamp(ctx, bodyX, bodyY, bodyW, bodyH, C.shirtLight, C.shirt, C.shirtShadow);

  // 领带
  ctx.fillStyle = C.outline;
  ctx.fillRect(cx - 3 + lean, bodyY + 2, 6, 2); // 领口轮廓
  ctx.fillStyle = C.tie;
  ctx.fillRect(cx - 2 + lean, bodyY + 4, 4, 14);
  ctx.fillStyle = C.tieShadow;
  ctx.fillRect(cx + lean, bodyY + 4, 2, 14);

  // 工牌（左胸）
  px(ctx, bodyX + 3, bodyY + 6, 6, 6, C.badge);
  ctx.fillStyle = C.dark;
  ctx.fillRect(bodyX + 4, bodyY + 8, 4, 1);

  // 手
  if (armRaise) {
    // 抬手（庆祝/举杯）
    px(ctx, bodyX - 5, bodyY + 2, 5, 8, C.skin);
    px(ctx, bodyX + bodyW, bodyY + 2, 5, 8, C.skin);
  } else if (holdingBox) {
    // 抱箱子（离职）
    ctx.fillStyle = C.outline;
    ctx.fillRect(bodyX - 8, bodyY + 8, bodyW + 16, 12);
    ctx.fillStyle = "#92602a"; // 纸箱棕
    ctx.fillRect(bodyX - 7, bodyY + 9, bodyW + 14, 10);
    ctx.fillStyle = C.dark;
    ctx.fillRect(bodyX - 7, bodyY + 13, bodyW + 14, 1); // 封箱线
  } else {
    px(ctx, bodyX - 5, bodyY + 10, 5, 10, C.skin);
    px(ctx, bodyX + bodyW, bodyY + 10, 5, 10, C.skin);
  }

  // 脚
  ctx.fillStyle = C.outline;
  ctx.fillRect(bodyX + 1, bodyY + bodyH, 8, 5);
  ctx.fillRect(bodyX + bodyW - 9, bodyY + bodyH, 8, 5);

  // ===== 头（chibi 大头）=====
  const headW = 22, headH = 20;
  const headX = cx - headW / 2 + lean;
  const headY = oy + 8 + headDy + slouch;
  // 头轮廓
  ctx.fillStyle = C.outline;
  ctx.fillRect(headX - 1, headY - 1, headW + 2, headH + 2);
  ctx.fillStyle = C.skin;
  ctx.fillRect(headX, headY, headW, headH);
  // 下颌收角（圆润）
  ctx.fillStyle = C.outline;
  ctx.fillRect(headX, headY + headH - 1, 2, 1);
  ctx.fillRect(headX + headW - 2, headY + headH - 1, 2, 1);
  // 脸颊阴影
  ctx.fillStyle = C.skinShadow;
  ctx.fillRect(headX + headW - 3, headY + headH - 5, 3, 4);

  // 头发（盖顶 + 鬓角）
  ctx.fillStyle = C.hair;
  ctx.fillRect(headX, headY, headW, 6);
  ctx.fillRect(headX, headY + 4, 3, 4);
  ctx.fillRect(headX + headW - 3, headY + 4, 3, 4);
  ctx.fillStyle = C.hairLight;
  ctx.fillRect(headX + 6, headY + 1, 4, 2); // 高光

  // 黑眼圈
  if (showDarkCircle) {
    ctx.fillStyle = C.darkCircle;
    ctx.fillRect(headX + 3, headY + 12, 6, 2);
    ctx.fillRect(headX + headW - 9, headY + 12, 6, 2);
  }

  // 腮红
  if (showBlush) {
    ctx.fillStyle = C.blush;
    ctx.fillRect(headX, headY + 11, 4, 4);
    ctx.fillRect(headX + headW - 4, headY + 11, 4, 4);
  }

  // 眉毛
  drawEyebrows(ctx, headX, headY, headW, eyebrowMode);

  // 眼睛
  const eyeY = headY + 10;
  const lex = headX + 4;
  const rex = headX + headW - 8;
  drawEyes(ctx, lex, rex, eyeY, eyeMode, glasses);

  // 嘴
  drawMouth(ctx, headX, headY, headW, mouthMode);

  // 汗滴
  if (showSweat) {
    ctx.fillStyle = C.sweat;
    ctx.fillRect(headX + headW + 1, headY + 4, 2, 4);
    ctx.fillRect(headX + headW + 2, headY + 3, 2, 2);
    ctx.fillStyle = C.white;
    ctx.fillRect(headX + headW + 1, headY + 4, 1, 1);
  }

  // zZ
  if (showZZ) {
    ctx.fillStyle = C.white;
    ctx.fillRect(headX + headW + 3, headY - 3, 3, 3);
    ctx.fillRect(headX + headW + 6, headY - 6, 2, 2);
    ctx.fillStyle = C.outline;
    ctx.fillRect(headX + headW + 3, headY, 3, 1);
  }

  // 度假墨镜
  if (glasses) {
    ctx.fillStyle = C.outline;
    ctx.fillRect(headX + 3, headY + 9, headW - 6, 5);
    ctx.fillStyle = C.dark;
    ctx.fillRect(headX + 4, headY + 10, headW - 8, 3);
    ctx.fillStyle = C.shirtShadow;
    ctx.fillRect(headX + headW / 2, headY + 10, 2, 3); // 鼻梁
  }
}

function drawEyebrows(ctx, hx, hy, hw, mode) {
  const by = hy + 7;
  const lb = hx + 4;
  const rb = hx + hw - 8;
  ctx.fillStyle = C.hair;
  switch (mode) {
    case "sad":
      ctx.fillRect(lb, by, 4, 1);
      ctx.fillRect(lb, by - 1, 2, 1);
      ctx.fillRect(rb + 1, by, 4, 1);
      ctx.fillRect(rb + 3, by - 1, 2, 1);
      break;
    case "raised":
      ctx.fillRect(lb, by - 2, 4, 1);
      ctx.fillRect(rb + 1, by - 2, 4, 1);
      break;
    case "angry":
      ctx.fillRect(lb + 2, by, 4, 1);
      ctx.fillRect(lb, by - 1, 2, 1);
      ctx.fillRect(rb, by, 4, 1);
      ctx.fillRect(rb + 4, by - 1, 2, 1);
      break;
  }
}

function drawEyes(ctx, lex, rex, ey, mode, glasses) {
  if (glasses) return; // 戴墨镜不画眼
  ctx.fillStyle = C.dark;
  switch (mode) {
    case "x":
      drawX(ctx, lex, ey);
      drawX(ctx, rex, ey);
      break;
    case "happy":
      ctx.fillRect(lex + 1, ey, 2, 1);
      ctx.fillRect(lex, ey + 1, 4, 1);
      ctx.fillRect(rex + 1, ey, 2, 1);
      ctx.fillRect(rex, ey + 1, 4, 1);
      break;
    case "tired":
    case "closed":
      ctx.fillRect(lex, ey + 1, 4, 1);
      ctx.fillRect(rex, ey + 1, 4, 1);
      break;
    default:
      ctx.fillRect(lex, ey, 4, 4);
      ctx.fillRect(rex, ey, 4, 4);
      ctx.fillStyle = C.white;
      ctx.fillRect(lex, ey, 2, 2);
      ctx.fillRect(rex, ey, 2, 2);
  }
}

function drawX(ctx, x, y) {
  ctx.fillStyle = C.dark;
  ctx.fillRect(x, y, 1, 1);
  ctx.fillRect(x + 3, y, 1, 1);
  ctx.fillRect(x + 1, y + 1, 2, 1);
  ctx.fillRect(x, y + 2, 1, 1);
  ctx.fillRect(x + 3, y + 2, 1, 1);
  ctx.fillRect(x + 1, y + 3, 2, 1);
}

function drawMouth(ctx, hx, hy, hw, mode) {
  const mx = hx + hw / 2 - 3;
  const my = hy + 16;
  ctx.fillStyle = C.dark;
  switch (mode) {
    case "frown":
      ctx.fillRect(mx, my, 1, 1);
      ctx.fillRect(mx + 1, my + 1, 4, 1);
      ctx.fillRect(mx + 5, my, 1, 1);
      break;
    case "smile":
      ctx.fillRect(mx, my + 1, 1, 1);
      ctx.fillRect(mx + 1, my, 4, 1);
      ctx.fillRect(mx + 5, my + 1, 1, 1);
      break;
    case "open":
      ctx.fillRect(mx, my, 1, 1);
      ctx.fillRect(mx + 5, my, 1, 1);
      ctx.fillRect(mx, my + 1, 6, 2);
      ctx.fillRect(mx + 1, my + 3, 4, 1);
      break;
    case "tremble":
      ctx.fillRect(mx, my, 2, 1);
      ctx.fillRect(mx + 4, my, 2, 1);
      ctx.fillRect(mx + 2, my + 1, 2, 1);
      break;
    default:
      ctx.fillRect(mx, my, 6, 1);
  }
}

/**
 * 侧面视角（walk/leave/return 用，64×64）。
 */
function drawPetSide(ctx, ox, oy, opts) {
  const { faceDir = 1, step = 0, bodyDy = 0, holdingBox = false } = opts;
  const cx = ox + 32;
  const dir = faceDir;

  // 身体
  pxRamp(ctx, cx - 11, oy + 30 + bodyDy, 22, 20, C.shirtLight, C.shirt, C.shirtShadow);

  // 领带
  ctx.fillStyle = C.tie;
  ctx.fillRect(cx - 2 + dir * 2, oy + 32 + bodyDy, 4, 12);

  // 头
  ctx.fillStyle = C.outline;
  ctx.fillRect(cx - 11, oy + 8 + bodyDy, 23, 21);
  ctx.fillStyle = C.skin;
  ctx.fillRect(cx - 10, oy + 9 + bodyDy, 21, 18);
  ctx.fillStyle = C.outline;
  ctx.fillRect(cx - 10, oy + 26 + bodyDy, 2, 1);
  ctx.fillRect(cx + 8, oy + 26 + bodyDy, 2, 1);

  // 头发（后脑厚）
  ctx.fillStyle = C.hair;
  ctx.fillRect(cx - 10 - dir, oy + 9 + bodyDy, 8, 7);
  ctx.fillRect(cx - 10, oy + 9 + bodyDy, 21, 2);
  ctx.fillStyle = C.hairLight;
  ctx.fillRect(cx - 8 - dir, oy + 10 + bodyDy, 3, 2);

  // 单眼
  ctx.fillStyle = C.dark;
  const eyeX = dir > 0 ? cx + 2 : cx - 6;
  ctx.fillRect(eyeX, oy + 13 + bodyDy, 4, 4);
  ctx.fillStyle = C.white;
  ctx.fillRect(eyeX, oy + 13 + bodyDy, 2, 2);

  // 嘴
  ctx.fillStyle = C.dark;
  ctx.fillRect(cx + dir * 3, oy + 19 + bodyDy, 3, 1);

  // 手（摆动或抱箱）
  if (holdingBox) {
    ctx.fillStyle = C.outline;
    ctx.fillRect(cx - 12, oy + 36 + bodyDy, 24, 12);
    ctx.fillStyle = "#92602a";
    ctx.fillRect(cx - 11, oy + 37 + bodyDy, 22, 10);
  } else {
    ctx.fillStyle = C.outline;
    const armX = dir > 0 ? cx + 10 : cx - 14;
    const off = step === 1 ? -2 : step === 2 ? 2 : 0;
    ctx.fillRect(armX, oy + 34 + bodyDy + off, 4, 10);
    ctx.fillStyle = C.skin;
    ctx.fillRect(armX + 1, oy + 35 + bodyDy + off, 2, 8);
  }

  // 脚（前后交替）
  ctx.fillStyle = C.outline;
  if (step === 1) {
    ctx.fillRect(cx + dir * 4, oy + 50 + bodyDy, 8, 5);
    ctx.fillRect(cx - dir * 6, oy + 50 + bodyDy, 7, 4);
  } else if (step === 2) {
    ctx.fillRect(cx + dir * 2, oy + 50 + bodyDy, 7, 4);
    ctx.fillRect(cx - dir * 8, oy + 50 + bodyDy, 8, 5);
  } else {
    ctx.fillRect(cx - 6, oy + 50 + bodyDy, 7, 5);
    ctx.fillRect(cx + 2, oy + 50 + bodyDy, 7, 5);
  }
}

function genAction(skinDir, action, frames) {
  const dir = path.join(skinDir, action);
  fs.mkdirSync(dir, { recursive: true });
  frames.forEach((opts, i) => {
    const canvas = createCanvas(FW, FH);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    drawPet(ctx, 0, 0, opts);
    fs.writeFileSync(path.join(dir, `${i + 1}.png`), canvas.toBuffer("image/png"));
  });
  console.log(`  ${action}: ${frames.length} 帧`);
}

function genSideAction(skinDir, action, frames) {
  const dir = path.join(skinDir, action);
  fs.mkdirSync(dir, { recursive: true });
  frames.forEach((opts, i) => {
    const canvas = createCanvas(FW, FH);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    drawPetSide(ctx, 0, 0, opts);
    fs.writeFileSync(path.join(dir, `${i + 1}.png`), canvas.toBuffer("image/png"));
  });
  console.log(`  ${action}(side): ${frames.length} 帧`);
}

// ===== 生成 default 皮肤（18 动作）=====
const skinDir = path.join(__dirname, "..", "skins", "default");
fs.rmSync(skinDir, { recursive: true, force: true });
fs.mkdirSync(skinDir, { recursive: true });
console.log(`生成 default 皮肤（${FW}×${FH}）→`, skinDir);

// 状态动作
genAction(skinDir, "idle", [
  { eyeMode: "normal", eyebrowMode: "none", mouthMode: "neutral" },
  { eyeMode: "normal", eyebrowMode: "none", mouthMode: "neutral", bodyDy: 2 },
  { eyeMode: "closed", eyebrowMode: "none", mouthMode: "neutral", bodyDy: 2 },
]);
genAction(skinDir, "working", [
  { eyeMode: "normal", eyebrowMode: "none", mouthMode: "neutral" },
  { eyeMode: "normal", eyebrowMode: "none", mouthMode: "neutral", bodyDy: 2 },
  { eyeMode: "normal", eyebrowMode: "none", mouthMode: "neutral" },
  { eyeMode: "normal", eyebrowMode: "none", mouthMode: "neutral", bodyDy: 2 },
]);
genAction(skinDir, "tired", [
  { eyeMode: "tired", eyebrowMode: "sad", mouthMode: "frown", showSweat: true, slouch: 2 },
  { eyeMode: "tired", eyebrowMode: "sad", mouthMode: "frown", showSweat: true, slouch: 2, bodyDy: 2 },
  { eyeMode: "closed", eyebrowMode: "sad", mouthMode: "frown", showSweat: true, slouch: 4 },
]);
genAction(skinDir, "exhausted", [
  { eyeMode: "x", eyebrowMode: "none", mouthMode: "open", slouch: 6 },
  { eyeMode: "x", eyebrowMode: "none", mouthMode: "open", slouch: 8 },
]);
genAction(skinDir, "overworked", [
  { eyeMode: "tired", eyebrowMode: "sad", mouthMode: "tremble", showDarkCircle: true, lean: -2 },
  { eyeMode: "tired", eyebrowMode: "sad", mouthMode: "tremble", showDarkCircle: true, lean: 2 },
  { eyeMode: "tired", eyebrowMode: "sad", mouthMode: "tremble", showDarkCircle: true, showSweat: true },
]);
genAction(skinDir, "nightshift", [
  { eyeMode: "tired", eyebrowMode: "sad", mouthMode: "open", showDarkCircle: true, showZZ: true },
  { eyeMode: "closed", eyebrowMode: "sad", mouthMode: "neutral", showDarkCircle: true, showZZ: true, slouch: 2 },
  { eyeMode: "tired", eyebrowMode: "sad", mouthMode: "open", showDarkCircle: true, showZZ: true },
]);
genAction(skinDir, "happy", [
  { eyeMode: "happy", eyebrowMode: "raised", mouthMode: "smile", showBlush: true, armRaise: true, bodyDy: -2 },
  { eyeMode: "happy", eyebrowMode: "raised", mouthMode: "smile", showBlush: true, armRaise: true },
  { eyeMode: "happy", eyebrowMode: "raised", mouthMode: "smile", showBlush: true, armRaise: true, bodyDy: -2 },
]);
// 交互
genAction(skinDir, "poke", [
  { eyeMode: "happy", eyebrowMode: "raised", mouthMode: "open", showBlush: true, bodyDy: -3 },
  { eyeMode: "normal", eyebrowMode: "none", mouthMode: "neutral", bodyDy: 2 },
]);
genAction(skinDir, "drag", [
  { eyeMode: "normal", eyebrowMode: "angry", mouthMode: "open", lean: -3 },
  { eyeMode: "normal", eyebrowMode: "angry", mouthMode: "open", lean: 3 },
]);
// 生动
genSideAction(skinDir, "walk", [
  { faceDir: 1, step: 0 },
  { faceDir: 1, step: 1 },
  { faceDir: 1, step: 0, bodyDy: -2 },
  { faceDir: 1, step: 2 },
]);
genAction(skinDir, "jump", [
  { eyeMode: "happy", eyebrowMode: "raised", mouthMode: "smile", bodyDy: -8 },
  { eyeMode: "normal", eyebrowMode: "none", mouthMode: "neutral", bodyDy: 0 },
]);
// 特殊事件
genSideAction(skinDir, "leave", [
  { faceDir: 1, step: 0, holdingBox: true },
  { faceDir: 1, step: 1, holdingBox: true },
  { faceDir: 1, step: 0, holdingBox: true, bodyDy: -2 },
  { faceDir: 1, step: 2, holdingBox: true },
]);
genSideAction(skinDir, "return", [
  { faceDir: 1, step: 0 },
  { faceDir: 1, step: 1 },
]);
genAction(skinDir, "promoted", [
  { eyeMode: "happy", eyebrowMode: "raised", mouthMode: "smile", showBlush: true },
  { eyeMode: "happy", eyebrowMode: "raised", mouthMode: "smile", showBlush: true, bodyDy: 1 },
  { eyeMode: "happy", eyebrowMode: "raised", mouthMode: "smile", showBlush: true },
]);
genAction(skinDir, "teambuilding", [
  { eyeMode: "happy", eyebrowMode: "raised", mouthMode: "smile", showBlush: true, armRaise: true },
  { eyeMode: "happy", eyebrowMode: "raised", mouthMode: "open", showBlush: true, armRaise: true },
  { eyeMode: "happy", eyebrowMode: "raised", mouthMode: "smile", showBlush: true, armRaise: true },
]);
genAction(skinDir, "lunchnap", [
  { eyeMode: "closed", eyebrowMode: "none", mouthMode: "open", slouch: 6 },
  { eyeMode: "closed", eyebrowMode: "none", mouthMode: "neutral", slouch: 6, bodyDy: 2 },
]);
genAction(skinDir, "payday", [
  { eyeMode: "happy", eyebrowMode: "raised", mouthMode: "smile", showBlush: true, armRaise: true },
  { eyeMode: "happy", eyebrowMode: "raised", mouthMode: "smile", showBlush: true, armRaise: true, bodyDy: -2 },
  { eyeMode: "happy", eyebrowMode: "raised", mouthMode: "smile", showBlush: true, armRaise: true },
]);
genAction(skinDir, "vacation", [
  { eyeMode: "closed", eyebrowMode: "none", mouthMode: "smile", glasses: true, bodyDy: 4 },
  { eyeMode: "closed", eyebrowMode: "none", mouthMode: "smile", glasses: true, bodyDy: 5 },
]);

console.log(`\n✅ default 皮肤生成完成（${FW}×${FH}，18 动作）`);
