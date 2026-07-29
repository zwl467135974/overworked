// generate-skin.cjs —— 生成 default 皮肤（按动作分文件夹）
//
// 输出：skins/default/<动作>/1.png 2.png ...
// 11 个动作，每个 2-4 帧，32×32 像素。
// 这是占位美术，后续用户用真图替换即可（文件名约定不变）。
//
// 用法：node scripts/generate-skin.cjs

const { createCanvas } = require("canvas");
const fs = require("fs");
const path = require("path");

const FW = 32;
const FH = 32;

// 颜色
const C = {
  skin: "#f1c27d",
  shirt: "#4b5563",
  shirtLight: "#6b7280",
  shirtIdle: "#9ca3af",
  shirtTired: "#d97706",
  shirtExhausted: "#dc2626",
  shirtOverworked: "#7f1d1d",
  shirtNight: "#5b21b6",
  shirtExcited: "#16a34a",
  shirtHappy: "#ca8a04",
  tie: "#7f1d1d",
  badge: "#fef3c7",
  dark: "#1f2937",
  white: "#ffffff",
  sweat: "#60a5fa",
  blush: "rgba(244,114,182,0.7)",
  shadow: "rgba(76,29,149,0.45)",
};

/**
 * 画一帧像素打工仔。
 * opts 控制姿态/色调，让不同动作有区分。
 */
function drawPet(ctx, ox, oy, opts) {
  const {
    shirt = C.shirt,
    bodyDy = 0, // 身体上下偏移（呼吸/跳）
    headDy = 0,
    eyeMode = "normal", // normal | x | happy | tired | closed
    showSweat = false,
    showBlush = false,
    showShadow = false, // 黑眼圈
    showZZ = false,
    lean = 0, // 左右倾斜（走路）
    armRaise = false, // 挥手/庆祝抬手
    walkStep = 0, // 走路步态：0=并拢 1=左脚前 2=右脚前（控制脚的画法）
    offsetX = 0, // 水平位移（走路时角色真的左右移动）
  } = opts;

  const cx = ox + 16 + offsetX; // 中心 x（含走路位移）

  // 脚（在身体下方，y+26 开始）
  ctx.fillStyle = C.dark;
  if (walkStep === 1) {
    // 左脚前
    ctx.fillRect(cx - 5 + lean, oy + 26 + bodyDy, 4, 3);
    ctx.fillRect(cx + 1 + lean, oy + 26 + bodyDy, 4, 2);
  } else if (walkStep === 2) {
    // 右脚前
    ctx.fillRect(cx - 5 + lean, oy + 26 + bodyDy, 4, 2);
    ctx.fillRect(cx + 1 + lean, oy + 26 + bodyDy, 4, 3);
  } else {
    // 并拢
    ctx.fillRect(cx - 5 + lean, oy + 26 + bodyDy, 4, 3);
    ctx.fillRect(cx + 1 + lean, oy + 26 + bodyDy, 4, 3);
  }

  // 身体
  ctx.fillStyle = shirt;
  ctx.fillRect(cx - 6 + lean, oy + 14 + bodyDy, 12, 12);

  // 领带
  ctx.fillStyle = C.tie;
  ctx.fillRect(cx - 1 + lean, oy + 16 + bodyDy, 2, 8);

  // 工牌
  ctx.fillStyle = C.badge;
  ctx.fillRect(cx - 4 + lean, oy + 17 + bodyDy, 4, 4);
  ctx.fillStyle = C.dark;
  ctx.fillRect(cx - 4 + lean, oy + 17 + bodyDy, 4, 1);
  ctx.fillRect(cx - 4 + lean, oy + 20 + bodyDy, 4, 1);

  // 领口
  ctx.fillStyle = C.white;
  ctx.fillRect(cx - 2 + lean, oy + 14 + bodyDy, 4, 2);

  // 手
  ctx.fillStyle = C.skin;
  if (armRaise) {
    // 抬手（挥手/庆祝）
    ctx.fillRect(cx - 8 + lean, oy + 10 + bodyDy, 3, 4);
    ctx.fillRect(cx + 5 + lean, oy + 10 + bodyDy, 3, 4);
  } else {
    ctx.fillRect(cx - 8 + lean, oy + 18 + bodyDy, 3, 6);
    ctx.fillRect(cx + 5 + lean, oy + 18 + bodyDy, 3, 6);
  }

  // 头
  ctx.fillStyle = C.skin;
  ctx.fillRect(cx - 5 + lean, oy + 6 + headDy, 10, 8);

  // 头发
  ctx.fillStyle = C.dark;
  ctx.fillRect(cx - 5 + lean, oy + 6 + headDy, 10, 2);

  // 黑眼圈
  if (showShadow) {
    ctx.fillStyle = C.shadow;
    ctx.fillRect(cx - 4 + lean, oy + 11 + headDy, 3, 1);
    ctx.fillRect(cx + 1 + lean, oy + 11 + headDy, 3, 1);
  }

  // 腮红
  if (showBlush) {
    ctx.fillStyle = C.blush;
    ctx.fillRect(cx - 5 + lean, oy + 11 + headDy, 2, 2);
    ctx.fillRect(cx + 3 + lean, oy + 11 + headDy, 2, 2);
  }

  // 眼睛
  const eyeY = oy + 9 + headDy;
  const lex = cx - 3 + lean;
  const rex = cx + 1 + lean;
  ctx.fillStyle = C.dark;
  switch (eyeMode) {
    case "x":
      drawXEye(ctx, lex, eyeY);
      drawXEye(ctx, rex, eyeY);
      break;
    case "happy":
      ctx.fillRect(lex + 1, eyeY, 1, 1);
      ctx.fillRect(lex, eyeY + 1, 3, 1);
      ctx.fillRect(rex + 1, eyeY, 1, 1);
      ctx.fillRect(rex, eyeY + 1, 3, 1);
      break;
    case "tired":
      ctx.fillRect(lex, eyeY + 1, 3, 1);
      ctx.fillRect(rex, eyeY + 1, 3, 1);
      break;
    case "closed":
      ctx.fillRect(lex, eyeY + 1, 3, 1);
      ctx.fillRect(rex, eyeY + 1, 3, 1);
      break;
    default:
      ctx.fillRect(lex, eyeY, 2, 2);
      ctx.fillRect(rex, eyeY, 2, 2);
  }

  // 嘴
  ctx.fillStyle = C.dark;
  ctx.fillRect(cx - 1 + lean, oy + 12 + headDy, 3, 1);

  // 汗滴
  if (showSweat) {
    ctx.fillStyle = C.sweat;
    ctx.fillRect(cx + 5 + lean, oy + 4 + headDy, 1, 2);
    ctx.fillRect(cx + 6 + lean, oy + 3 + headDy, 1, 1);
  }

  // zZ（夜班）
  if (showZZ) {
    ctx.fillStyle = C.white;
    ctx.fillRect(cx + 7 + lean, oy + 2 + headDy, 1, 1);
    ctx.fillRect(cx + 8 + lean, oy + 1 + headDy, 1, 1);
  }
}

/**
 * 画侧面视角的像素打工仔（用于 walk 动作）。
 * faceDir: 1=朝右, -1=朝左
 * step: 0=站立, 1=左脚前, 2=右脚前
 */
function drawPetSide(ctx, ox, oy, opts) {
  const { shirt = C.shirt, faceDir = 1, step = 0, bodyDy = 0 } = opts;
  const cx = ox + 16;
  const dir = faceDir; // 朝向

  // 侧面身体（窄一点，10 宽）
  ctx.fillStyle = shirt;
  ctx.fillRect(cx - 5, oy + 14 + bodyDy, 10, 12);

  // 领带（侧面只露一条）
  ctx.fillStyle = C.tie;
  ctx.fillRect(cx - 1 + dir, oy + 15 + bodyDy, 2, 7);

  // 侧面头（朝向 dir，脸在 dir 侧）
  ctx.fillStyle = C.skin;
  ctx.fillRect(cx - 4, oy + 6 + bodyDy, 8, 8);

  // 头发（侧面：后脑勺多，前面少）
  ctx.fillStyle = C.dark;
  ctx.fillRect(cx - 4 - dir, oy + 6 + bodyDy, 4, 3); // 后脑
  ctx.fillRect(cx - 4, oy + 6 + bodyDy, 8, 1); // 顶

  // 侧面单眼（朝向 dir 那侧）
  ctx.fillStyle = C.dark;
  const eyeX = dir > 0 ? cx + 1 : cx - 3;
  ctx.fillRect(eyeX, oy + 9 + bodyDy, 2, 2);

  // 嘴
  ctx.fillRect(cx + dir, oy + 12 + bodyDy, 2, 1);

  // 侧面手（一只在前，摆动）
  ctx.fillStyle = C.skin;
  const armX = dir > 0 ? cx + 4 : cx - 6;
  const armOffset = step === 1 ? -1 : step === 2 ? 1 : 0;
  ctx.fillRect(armX, oy + 16 + bodyDy + armOffset, 2, 5);

  // 侧面脚（前后交替，体现走路）
  ctx.fillStyle = C.dark;
  if (step === 1) {
    // 前脚（dir 侧）伸出
    ctx.fillRect(cx + dir * 2, oy + 26 + bodyDy, 4, 3);
    ctx.fillRect(cx - dir * 3, oy + 26 + bodyDy, 3, 2);
  } else if (step === 2) {
    // 后脚（-dir 侧）伸出
    ctx.fillRect(cx + dir, oy + 26 + bodyDy, 3, 2);
    ctx.fillRect(cx - dir * 4, oy + 26 + bodyDy, 4, 3);
  } else {
    ctx.fillRect(cx - 3, oy + 26 + bodyDy, 3, 3);
    ctx.fillRect(cx + 1, oy + 26 + bodyDy, 3, 3);
  }
}

function drawXEye(ctx, x, y) {
  ctx.fillStyle = C.dark;
  ctx.fillRect(x, y, 1, 1);
  ctx.fillRect(x + 2, y, 1, 1);
  ctx.fillRect(x + 1, y + 1, 1, 1);
  ctx.fillRect(x, y + 2, 1, 1);
  ctx.fillRect(x + 2, y + 2, 1, 1);
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

/** 生成侧面视角的动作帧（用于 walk） */
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

// idle: 3 帧，站立呼吸，偶数帧下移 1px
genAction(skinDir, "idle", [
  { shirt: C.shirtIdle, eyeMode: "normal" },
  { shirt: C.shirtIdle, eyeMode: "normal", bodyDy: 1, headDy: 1 },
  { shirt: C.shirtIdle, eyeMode: "closed", bodyDy: 1, headDy: 1 }, // 眨眼
]);

// working: 4 帧，身体微动，打字状
genAction(skinDir, "working", [
  { shirt: C.shirt, eyeMode: "normal" },
  { shirt: C.shirt, eyeMode: "normal", bodyDy: 1, headDy: 1 },
  { shirt: C.shirt, eyeMode: "normal" },
  { shirt: C.shirt, eyeMode: "normal", bodyDy: 1, headDy: 1 },
]);

// tired: 3 帧，趴桌感（头低），冒汗
genAction(skinDir, "tired", [
  { shirt: C.shirtTired, eyeMode: "tired", showSweat: true, headDy: 1 },
  { shirt: C.shirtTired, eyeMode: "tired", showSweat: true, headDy: 2, bodyDy: 1 },
  { shirt: C.shirtTired, eyeMode: "closed", showSweat: true, headDy: 2, bodyDy: 1 },
]);

// exhausted: 2 帧，X 眼瘫倒
genAction(skinDir, "exhausted", [
  { shirt: C.shirtExhausted, eyeMode: "x", bodyDy: 2 },
  { shirt: C.shirtExhausted, eyeMode: "x", bodyDy: 3 },
]);

// overworked: 3 帧，黑眼圈 + 颤抖（左右偏）
genAction(skinDir, "overworked", [
  { shirt: C.shirtOverworked, eyeMode: "tired", showShadow: true, lean: -1 },
  { shirt: C.shirtOverworked, eyeMode: "tired", showShadow: true, lean: 1 },
  { shirt: C.shirtOverworked, eyeMode: "tired", showShadow: true, lean: 0, showSweat: true },
]);

// nightshift: 3 帧，黑眼圈 + zZ
genAction(skinDir, "nightshift", [
  { shirt: C.shirtNight, eyeMode: "tired", showShadow: true, showZZ: true },
  { shirt: C.shirtNight, eyeMode: "closed", showShadow: true, showZZ: true, headDy: 1 },
  { shirt: C.shirtNight, eyeMode: "tired", showShadow: true, showZZ: true },
]);

// happy: 3 帧，^眼 + 腮红 + 抬手庆祝
genAction(skinDir, "happy", [
  { shirt: C.shirtHappy, eyeMode: "happy", showBlush: true, armRaise: true, bodyDy: -1 },
  { shirt: C.shirtHappy, eyeMode: "happy", showBlush: true, armRaise: true },
  { shirt: C.shirtHappy, eyeMode: "happy", showBlush: true, armRaise: true, bodyDy: -1 },
]);

// poke: 2 帧，被戳反应（惊 + 缩）
genAction(skinDir, "poke", [
  { shirt: C.shirtExcited, eyeMode: "happy", showBlush: true, bodyDy: -1 }, // 惊跳
  { shirt: C.shirtExcited, eyeMode: "normal", bodyDy: 1 }, // 落回
]);

// drag: 2 帧，被拖动（挣扎）
genAction(skinDir, "drag", [
  { shirt: C.shirt, eyeMode: "normal", lean: -2 },
  { shirt: C.shirt, eyeMode: "normal", lean: 2 },
]);

// walk: 4 帧侧面走路（朝右，步态交替）。窗口平移由前端控制。
genSideAction(skinDir, "walk", [
  { shirt: C.shirt, faceDir: 1, step: 0 },
  { shirt: C.shirt, faceDir: 1, step: 1 },
  { shirt: C.shirt, faceDir: 1, step: 0, bodyDy: -1 },
  { shirt: C.shirt, faceDir: 1, step: 2 },
]);

// jump: 2 帧，跳（起 + 落）
genAction(skinDir, "jump", [
  { shirt: C.shirt, eyeMode: "happy", bodyDy: -4 },
  { shirt: C.shirt, eyeMode: "normal", bodyDy: 0 },
]);

console.log("\n✅ default 皮肤生成完成（11 动作）");
