// generate-skin.cjs —— 生成 default 皮肤（按动作分文件夹）
//
// 输出：skins/default/<动作>/1.png 2.png ...
// 11 个动作，每个 2-4 帧，32×32 像素。
//
// 设计原则（基于像素角色设计研究）：
// - 剪影优先：每个状态轮廓要不同（不是只换颜色）
// - 减法艺术：3 色阶（亮/中/暗）+ 轮廓 + 强调色，克制
// - chibi 比例：大头小身，激活可爱反射
// - 神态 = 眉毛 + 嘴（眼睛辅助）：眉毛角度 + 嘴形传达情绪
// - 萌惨反差：大头圆脸(萌) × 八字眉下垂嘴(惨)
//
// 用法：node scripts/generate-skin.cjs

const { createCanvas } = require("canvas");
const fs = require("fs");
const path = require("path");

const FW = 32;
const FH = 32;

// 配色（3 级色阶 ramp + 轮廓 + 强调）
const C = {
  // 轮廓（比所有色都深，1px 描边用）
  outline: "#1a1f29",
  // 皮肤色阶
  skin: "#f1c27d",
  skinShadow: "#d9a55c",
  // 头发
  hair: "#3a2e25",
  // 衬衫色阶（灰蓝调，有温度不死灰）
  shirtLight: "#6b7480",
  shirt: "#4b5563",
  shirtShadow: "#2d333f",
  // 强调色（领带，要跳）
  tie: "#c2410c",
  // 工牌
  badge: "#fef3c7",
  // 情绪色
  dark: "#1a1f29",
  white: "#ffffff",
  sweat: "#60a5fa",
  blush: "rgba(244,114,182,0.7)",
  darkCircle: "rgba(76,29,149,0.5)",
};

/**
 * 画一帧像素打工仔（正面）。
 * 基于像素艺术原则：轮廓 + 色阶 + 眉毛 + 嘴形 + chibi 比例。
 */
function drawPet(ctx, ox, oy, opts) {
  const {
    bodyDy = 0,
    headDy = 0,
    eyeMode = "normal", // normal | x | happy | tired | closed
    eyebrowMode = "none", // none | sad | raised | angry
    mouthMode = "neutral", // neutral | frown | smile | open | tremble
    showSweat = false,
    showBlush = false,
    showDarkCircle = false,
    showZZ = false,
    lean = 0,
    armRaise = false,
    slouch = 0, // 塌肩程度（0=直，正值=驼背前倾）
  } = opts;

  const cx = ox + 16;

  // ===== 轮廓辅助：先画大一圈的轮廓色，再画本体 =====
  // 用 px(x,y,w,h,color) 画带轮廓的实体块
  function px(x, y, w, h, color) {
    ctx.fillStyle = C.outline;
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  }
  // 用 pxs 画带轮廓+色阶（右侧/下侧加阴影）
  function pxRamp(x, y, w, h, light, mid, shadow) {
    ctx.fillStyle = C.outline;
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = mid;
    ctx.fillRect(x, y, w, h);
    // 右侧阴影
    ctx.fillStyle = shadow;
    ctx.fillRect(x + w - 2, y, 2, h);
    // 顶部受光
    ctx.fillStyle = light;
    ctx.fillRect(x, y, w, 1);
  }

  const bodyX = cx - 6 + lean;
  const bodyY = oy + 15 + bodyDy + slouch;

  // ===== 身体（衬衫，色阶 ramp）=====
  pxRamp(bodyX, bodyY, 12, 12, C.shirtLight, C.shirt, C.shirtShadow);

  // 领带（强调色，居中）
  ctx.fillStyle = C.outline;
  ctx.fillRect(cx - 2 + lean, bodyY + 1, 4, 1); // 领口轮廓
  ctx.fillStyle = C.tie;
  ctx.fillRect(cx - 1 + lean, bodyY + 2, 2, 8);
  ctx.fillStyle = "#7c2d12"; // 领带阴影
  ctx.fillRect(cx + lean, bodyY + 2, 1, 8);

  // 工牌（简化：3×3 色块，不再画细节线）
  px(bodyX + 2, bodyY + 4, 3, 3, C.badge);

  // 手
  ctx.fillStyle = C.outline;
  ctx.fillRect(bodyX - 3, bodyY + 6, 4, 7); // 左手轮廓
  ctx.fillRect(bodyX + 11, bodyY + 6, 4, 7); // 右手轮廓
  ctx.fillStyle = C.skin;
  ctx.fillRect(bodyX - 2, bodyY + 7, 2, 5);
  ctx.fillRect(bodyX + 12, bodyY + 7, 2, 5);

  // ===== 脚 =====
  ctx.fillStyle = C.outline;
  ctx.fillRect(bodyX, bodyY + 12, 5, 3);
  ctx.fillRect(bodyX + 7, bodyY + 12, 5, 3);

  // ===== 头（chibi：更大更圆，下颌收角）=====
  const headX = cx - 6 + lean;
  const headY = oy + 5 + headDy + slouch;
  // 头轮廓（10×9，下颌收 2 角像素做圆润感）
  ctx.fillStyle = C.outline;
  ctx.fillRect(headX - 1, headY - 1, 12, 11);
  ctx.fillStyle = C.skin;
  ctx.fillRect(headX, headY, 10, 9);
  // 下颌收角（去掉左下右下各 1 像素，变圆润）
  ctx.fillStyle = C.outline;
  ctx.fillRect(headX, headY + 8, 1, 1);
  ctx.fillRect(headX + 9, headY + 8, 1, 1);

  // 头发（盖顶 + 后脑，chibi 偏厚）
  ctx.fillStyle = C.hair;
  ctx.fillRect(headX, headY, 10, 3);
  ctx.fillRect(headX, headY + 2, 2, 2); // 左鬓
  ctx.fillRect(headX + 8, headY + 2, 2, 2); // 右鬓
  // 头发高光
  ctx.fillStyle = "#5a4636";
  ctx.fillRect(headX + 3, headY + 1, 2, 1);

  // ===== 黑眼圈 =====
  if (showDarkCircle) {
    ctx.fillStyle = C.darkCircle;
    ctx.fillRect(headX + 1, headY + 6, 3, 1);
    ctx.fillRect(headX + 6, headY + 6, 3, 1);
  }

  // ===== 腮红 =====
  if (showBlush) {
    ctx.fillStyle = C.blush;
    ctx.fillRect(headX, headY + 6, 2, 2);
    ctx.fillRect(headX + 8, headY + 6, 2, 2);
  }

  // ===== 眉毛（神态第一杠杆）=====
  drawEyebrows(ctx, headX, headY, eyebrowMode);

  // ===== 眼睛 =====
  const eyeY = headY + 5;
  const lex = headX + 2;
  const rex = headX + 6;
  drawEyes(ctx, lex, rex, eyeY, eyeMode);

  // ===== 嘴（随状态变化，第二大改造）=====
  drawMouth(ctx, headX, headY, mouthMode);

  // ===== 汗滴 =====
  if (showSweat) {
    ctx.fillStyle = C.sweat;
    ctx.fillRect(headX + 10, headY + 2, 1, 2);
    ctx.fillRect(headX + 11, headY + 1, 1, 1);
  }

  // ===== zZ（夜班）=====
  if (showZZ) {
    ctx.fillStyle = C.white;
    ctx.fillRect(headX + 11, headY - 2, 1, 1);
    ctx.fillRect(headX + 12, headY - 3, 1, 1);
    ctx.fillStyle = C.outline;
    ctx.fillRect(headX + 11, headY - 1, 1, 1);
  }
}

/** 画眉毛（1-2px，角度传达情绪） */
function drawEyebrows(ctx, hx, hy, mode) {
  const browY = hy + 3;
  const lb = hx + 2; // 左眉起点
  const rb = hx + 6; // 右眉起点
  ctx.fillStyle = C.hair;
  switch (mode) {
    case "sad": // 八字眉（外端下垂）→ 委屈/疲惫
      ctx.fillRect(lb, browY, 2, 1);
      ctx.fillRect(lb, browY - 1, 1, 1); // 内端高
      ctx.fillRect(rb + 1, browY, 2, 1);
      ctx.fillRect(rb + 2, browY - 1, 1, 1); // 内端高（镜像）
      break;
    case "raised": // 上扬（惊讶/被戳）
      ctx.fillRect(lb, browY - 1, 2, 1);
      ctx.fillRect(rb + 1, browY - 1, 2, 1);
      break;
    case "angry": // 怒眉（内端下垂）→ 愤怒/崩溃
      ctx.fillRect(lb + 1, browY, 2, 1);
      ctx.fillRect(lb, browY - 1, 1, 1); // 外端高
      ctx.fillRect(rb, browY, 2, 1);
      ctx.fillRect(rb + 2, browY - 1, 1, 1); // 外端高
      break;
    // none: 不画眉毛
  }
}

/** 画眼睛 */
function drawEyes(ctx, lex, rex, ey, mode) {
  ctx.fillStyle = C.dark;
  switch (mode) {
    case "x": // X 眼（瘫了）
      drawX(ctx, lex, ey);
      drawX(ctx, rex, ey);
      break;
    case "happy": // ^ 眼（开心）
      ctx.fillRect(lex + 1, ey, 1, 1);
      ctx.fillRect(lex, ey + 1, 3, 1);
      ctx.fillRect(rex + 1, ey, 1, 1);
      ctx.fillRect(rex, ey + 1, 3, 1);
      break;
    case "tired": // 半睁（横线）
      ctx.fillRect(lex, ey + 1, 3, 1);
      ctx.fillRect(rex, ey + 1, 3, 1);
      break;
    case "closed": // 闭眼（横线）
      ctx.fillRect(lex, ey + 1, 3, 1);
      ctx.fillRect(rex, ey + 1, 3, 1);
      break;
    default: // 圆眼
      ctx.fillRect(lex, ey, 2, 2);
      ctx.fillRect(rex, ey, 2, 2);
      // 眼神光
      ctx.fillStyle = C.white;
      ctx.fillRect(lex, ey, 1, 1);
      ctx.fillRect(rex, ey, 1, 1);
  }
}

function drawX(ctx, x, y) {
  ctx.fillStyle = C.dark;
  ctx.fillRect(x, y, 1, 1);
  ctx.fillRect(x + 2, y, 1, 1);
  ctx.fillRect(x + 1, y + 1, 1, 1);
  ctx.fillRect(x, y + 2, 1, 1);
  ctx.fillRect(x + 2, y + 2, 1, 1);
}

/** 画嘴（随状态变化） */
function drawMouth(ctx, hx, hy, mode) {
  const mx = hx + 4;
  const my = hy + 8;
  ctx.fillStyle = C.dark;
  switch (mode) {
    case "frown": // 下垂（委屈/累）
      ctx.fillRect(mx, my, 1, 1);
      ctx.fillRect(mx + 1, my + 1, 1, 1);
      ctx.fillRect(mx + 2, my, 1, 1);
      break;
    case "smile": // 上扬（开心）
      ctx.fillRect(mx, my + 1, 1, 1);
      ctx.fillRect(mx + 1, my, 1, 1);
      ctx.fillRect(mx + 2, my + 1, 1, 1);
      break;
    case "open": // 张开 O（惊讶/瘫倒喘气）
      ctx.fillRect(mx, my, 1, 1);
      ctx.fillRect(mx + 2, my, 1, 1);
      ctx.fillRect(mx, my + 1, 3, 1);
      ctx.fillRect(mx, my + 2, 1, 1);
      ctx.fillRect(mx + 2, my + 2, 1, 1);
      break;
    case "tremble": // 抖动直线（过劳）
      ctx.fillRect(mx, my, 1, 1);
      ctx.fillRect(mx + 2, my, 1, 1);
      ctx.fillRect(mx + 1, my + 1, 1, 1);
      break;
    default: // 中性直线
      ctx.fillRect(mx, my, 3, 1);
  }
}

/**
 * 侧面视角（walk 动作用）。
 */
function drawPetSide(ctx, ox, oy, opts) {
  const { faceDir = 1, step = 0, bodyDy = 0 } = opts;
  const cx = ox + 16;
  const dir = faceDir;

  // 身体（侧面，色阶）
  ctx.fillStyle = C.outline;
  ctx.fillRect(cx - 6, oy + 14 + bodyDy, 12, 13);
  ctx.fillStyle = C.shirt;
  ctx.fillRect(cx - 5, oy + 15 + bodyDy, 10, 11);
  ctx.fillStyle = C.shirtShadow;
  ctx.fillRect(cx + 3, oy + 15 + bodyDy, 2, 11);

  // 领带（侧面）
  ctx.fillStyle = C.tie;
  ctx.fillRect(cx - 1 + dir, oy + 16 + bodyDy, 2, 7);

  // 头（侧面，朝 dir）
  ctx.fillStyle = C.outline;
  ctx.fillRect(cx - 5, oy + 5 + bodyDy, 11, 10);
  ctx.fillStyle = C.skin;
  ctx.fillRect(cx - 4, oy + 6 + bodyDy, 9, 8);
  // 下颌收角
  ctx.fillStyle = C.outline;
  ctx.fillRect(cx - 4, oy + 13 + bodyDy, 1, 1);
  ctx.fillRect(cx + 4, oy + 13 + bodyDy, 1, 1);

  // 头发（侧面后脑厚）
  ctx.fillStyle = C.hair;
  ctx.fillRect(cx - 4 - dir, oy + 6 + bodyDy, 4, 4);
  ctx.fillRect(cx - 4, oy + 6 + bodyDy, 9, 1);

  // 侧面单眼
  ctx.fillStyle = C.dark;
  const eyeX = dir > 0 ? cx + 1 : cx - 3;
  ctx.fillRect(eyeX, oy + 9 + bodyDy, 2, 2);

  // 嘴
  ctx.fillRect(cx + dir, oy + 12 + bodyDy, 2, 1);

  // 手（摆动）
  ctx.fillStyle = C.outline;
  const armX = dir > 0 ? cx + 5 : cx - 7;
  const armOff = step === 1 ? -1 : step === 2 ? 1 : 0;
  ctx.fillRect(armX, oy + 16 + bodyDy + armOff, 3, 6);
  ctx.fillStyle = C.skin;
  ctx.fillRect(armX + 1, oy + 17 + bodyDy + armOff, 1, 4);

  // 脚（前后交替）
  ctx.fillStyle = C.outline;
  if (step === 1) {
    ctx.fillRect(cx + dir * 2, oy + 26 + bodyDy, 5, 3);
    ctx.fillRect(cx - dir * 3, oy + 26 + bodyDy, 4, 2);
  } else if (step === 2) {
    ctx.fillRect(cx + dir, oy + 26 + bodyDy, 4, 2);
    ctx.fillRect(cx - dir * 4, oy + 26 + bodyDy, 5, 3);
  } else {
    ctx.fillRect(cx - 3, oy + 26 + bodyDy, 4, 3);
    ctx.fillRect(cx + 1, oy + 26 + bodyDy, 4, 3);
  }
}

/** 生成一个动作的所有帧 */
function genAction(skinDir, action, frames) {
  const dir = path.join(skinDir, action);
  fs.mkdirSync(dir, { recursive: true });
  frames.forEach((opts, i) => {
    const canvas = createCanvas(FW, FH);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    drawPet(ctx, 0, 0, opts);
    const buf = canvas.toBuffer("image/png");
    fs.writeFileSync(path.join(dir, `${i + 1}.png`), buf);
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
    const buf = canvas.toBuffer("image/png");
    fs.writeFileSync(path.join(dir, `${i + 1}.png`), buf);
  });
  console.log(`  ${action}(side): ${frames.length} 帧`);
}

// ===== 生成 default 皮肤 =====
const skinDir = path.join(__dirname, "..", "skins", "default");
fs.rmSync(skinDir, { recursive: true, force: true });
fs.mkdirSync(skinDir, { recursive: true });
console.log("生成 default 皮肤 →", skinDir);

// idle: 3 帧，直立呼吸 + 眨眼（中性神态）
genAction(skinDir, "idle", [
  { eyeMode: "normal", eyebrowMode: "none", mouthMode: "neutral" },
  { eyeMode: "normal", eyebrowMode: "none", mouthMode: "neutral", bodyDy: 1 },
  { eyeMode: "closed", eyebrowMode: "none", mouthMode: "neutral", bodyDy: 1 },
]);

// working: 4 帧，身体微动，专注神态（平眉 + 中性嘴）
genAction(skinDir, "working", [
  { eyeMode: "normal", eyebrowMode: "none", mouthMode: "neutral" },
  { eyeMode: "normal", eyebrowMode: "none", mouthMode: "neutral", bodyDy: 1 },
  { eyeMode: "normal", eyebrowMode: "none", mouthMode: "neutral" },
  { eyeMode: "normal", eyebrowMode: "none", mouthMode: "neutral", bodyDy: 1 },
]);

// tired: 3 帧，八字眉 + 下垂嘴 + 汗 + 微驼背（委屈萌）
genAction(skinDir, "tired", [
  { eyeMode: "tired", eyebrowMode: "sad", mouthMode: "frown", showSweat: true, slouch: 1 },
  { eyeMode: "tired", eyebrowMode: "sad", mouthMode: "frown", showSweat: true, slouch: 1, bodyDy: 1 },
  { eyeMode: "closed", eyebrowMode: "sad", mouthMode: "frown", showSweat: true, slouch: 2 },
]);

// exhausted: 2 帧，X眼 + 张嘴 + 大驼背（瘫倒剪影）
genAction(skinDir, "exhausted", [
  { eyeMode: "x", eyebrowMode: "none", mouthMode: "open", slouch: 3 },
  { eyeMode: "x", eyebrowMode: "none", mouthMode: "open", slouch: 4 },
]);

// overworked: 3 帧，八字眉 + 抖嘴 + 颤抖 + 黑眼圈（崩溃边缘）
genAction(skinDir, "overworked", [
  { eyeMode: "tired", eyebrowMode: "sad", mouthMode: "tremble", showDarkCircle: true, lean: -1 },
  { eyeMode: "tired", eyebrowMode: "sad", mouthMode: "tremble", showDarkCircle: true, lean: 1 },
  { eyeMode: "tired", eyebrowMode: "sad", mouthMode: "tremble", showDarkCircle: true, showSweat: true },
]);

// nightshift: 3 帧，八字眉 + 黑眼圈 + zZ（夜班打盹）
genAction(skinDir, "nightshift", [
  { eyeMode: "tired", eyebrowMode: "sad", mouthMode: "open", showDarkCircle: true, showZZ: true },
  { eyeMode: "closed", eyebrowMode: "sad", mouthMode: "neutral", showDarkCircle: true, showZZ: true, slouch: 1 },
  { eyeMode: "tired", eyebrowMode: "sad", mouthMode: "open", showDarkCircle: true, showZZ: true },
]);

// happy: 3 帧，^眼 + 笑嘴 + 腮红 + 抬手（庆祝）
genAction(skinDir, "happy", [
  { eyeMode: "happy", eyebrowMode: "raised", mouthMode: "smile", showBlush: true, armRaise: true, bodyDy: -1 },
  { eyeMode: "happy", eyebrowMode: "raised", mouthMode: "smile", showBlush: true, armRaise: true },
  { eyeMode: "happy", eyebrowMode: "raised", mouthMode: "smile", showBlush: true, armRaise: true, bodyDy: -1 },
]);

// poke: 2 帧，上扬眉 + 张嘴 + 惊跳（被戳反应）
genAction(skinDir, "poke", [
  { eyeMode: "happy", eyebrowMode: "raised", mouthMode: "open", showBlush: true, bodyDy: -1 },
  { eyeMode: "normal", eyebrowMode: "none", mouthMode: "neutral", bodyDy: 1 },
]);

// drag: 2 帧，挣扎（左右歪）
genAction(skinDir, "drag", [
  { eyeMode: "normal", eyebrowMode: "angry", mouthMode: "open", lean: -2 },
  { eyeMode: "normal", eyebrowMode: "angry", mouthMode: "open", lean: 2 },
]);

// walk: 4 帧侧面
genSideAction(skinDir, "walk", [
  { faceDir: 1, step: 0 },
  { faceDir: 1, step: 1 },
  { faceDir: 1, step: 0, bodyDy: -1 },
  { faceDir: 1, step: 2 },
]);

// jump: 2 帧，^眼 + 起落
genAction(skinDir, "jump", [
  { eyeMode: "happy", eyebrowMode: "raised", mouthMode: "smile", bodyDy: -4 },
  { eyeMode: "normal", eyebrowMode: "none", mouthMode: "neutral", bodyDy: 0 },
]);

console.log("\n✅ default 皮肤生成完成（11 动作）");
