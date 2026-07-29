// Overworked 前端 —— 桌宠像素打工仔 渲染引擎
//
// 设计红线（见 overworked_design_principles）：
// - 红线 1（不爹味）：冒泡只反应不教育，3 秒消失
// - 红线 2（不暴露数值）：前端只收 ExpressionPayload（渲染指令），拿不到体力/心情/存款
// - 红线 3（不抢焦点）：透明留白区点击穿透；不弹窗，右键菜单极简
//
// 渲染策略：requestAnimationFrame 持续渲染，每帧应用 payload 特效。
// "一张图变桌宠"：优先加载用户图 (assets/pet.png)，失败则画默认像素小人。

const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const win = getCurrentWindow();

const canvas = document.getElementById("pet");
const ctx = canvas.getContext("2d");
ctx.imageSmoothingEnabled = false;

// ===== 角色矩形（用于点击穿透的碰撞检测）=====
// Canvas 钉在窗口底部居中：窗口 160 宽，Canvas 96 宽，左边距 32，底部 0
const PET_RECT = { left: 32, top: 104, right: 128, bottom: 200 };

// ===== 状态：当前表情的表现层指令 =====
let currentPayload = {
  expression: "Working",
  brightness: 1.0,
  rotation: 0.0,
  opacity: 1.0,
  tint: null,
  bounce: "none",
};

// ===== 用户图加载（"一张图变桌宠"主路径） =====
let petImage = null;
const img = new Image();
img.onload = () => {
  petImage = img;
};
img.onerror = () => {
  /* 无用户图，使用默认像素小人 */
};
img.src = "assets/pet.png";

// ===== 待机微动状态 =====
let blinkUntil = 0; // 眨眼结束时间戳，0=不眨
let nextBlinkAt = performance.now() + 3000 + Math.random() * 2000; // 下次眨眼
let shiftX = 0; // 换重心偏移（-1/0/1）
let shiftUntil = 0; // 换重心结束时间
let nextShiftAt = performance.now() + 8000 + Math.random() * 4000; // 下次换重心

// ===== 点击穿透（暂不启用） =====
// Tauri 的 set_ignore_cursor_events 是全窗口开关，动态切换有死锁风险
// （开了穿透就收不到 mousemove 切回来）。MVP 阶段优先保证角色可交互，
// 透明留白区会挡下层——这个代价可接受。穿透留到下迭代用 Rust 全局钩子重做。
// Rust 侧 set_cursor_passthrough command 保留备用。

// ===== 单击 poke / 拖动分离 =====
// mousedown 记录位置和时间；mouseup 时若移动小且时间短=单击poke；
// 移动超过阈值=触发拖动 startDragging。
let mouseDown = null;
canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return; // 只处理左键
  mouseDown = { x: e.screenX, y: e.screenY, t: performance.now(), dragged: false };
});

document.addEventListener("mousemove", (e) => {
  if (!mouseDown || mouseDown.dragged) return;
  const dx = e.screenX - mouseDown.x;
  const dy = e.screenY - mouseDown.y;
  if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
    // 超过阈值，开始拖动窗口
    mouseDown.dragged = true;
    win.startDragging();
  }
});

canvas.addEventListener("mouseup", (e) => {
  if (e.button !== 0 || !mouseDown) return;
  const dt = performance.now() - mouseDown.t;
  // 短按且未拖动 = poke
  if (!mouseDown.dragged && dt < 400) {
    invoke("poke_pet").catch((err) => console.error("poke", err));
  }
  mouseDown = null;
});

// ===== 右键菜单（PRD 三项，禁掉 webview 默认菜单） =====
canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  invoke("show_context_menu").catch((err) => console.error("menu", err));
});

// ===== 渲染主循环 =====
function render(now) {
  const t = now / 1000;

  // 待机微动判定
  updateMicroAnim(now);

  // 抖动偏移
  const { dx: bounceDx, dy: bounceDy } = computeBounce(currentPayload.bounce, t);

  ctx.clearRect(0, 0, 96, 96);
  ctx.globalAlpha = currentPayload.opacity;

  // 滤镜：亮度 + 色调
  const filterParts = [];
  if (currentPayload.brightness !== 1.0) {
    filterParts.push(`brightness(${currentPayload.brightness})`);
  }
  if (currentPayload.tint) {
    filterParts.push("sepia(1) saturate(2)");
    filterParts.push(`hue-rotate(${rgbToHueRotate(currentPayload.tint)}deg)`);
  }
  ctx.filter = filterParts.join(" ") || "none";

  // 居中 + 旋转 + 抖动 + 换重心偏移
  ctx.save();
  ctx.translate(48 + bounceDx + shiftX, 48 + bounceDy);
  ctx.rotate(currentPayload.rotation);

  if (petImage) {
    const size = 64;
    ctx.drawImage(petImage, -size / 2, -size / 2, size, size);
  } else {
    drawDefaultPet(currentPayload.expression, t, now);
  }
  ctx.restore();

  ctx.filter = "none";
  ctx.globalAlpha = 1.0;

  requestAnimationFrame(render);
}

/** 更新待机微动状态（眨眼 + 换重心） */
function updateMicroAnim(now) {
  // 眨眼：到时间触发，持续 150ms
  if (blinkUntil === 0 && now >= nextBlinkAt) {
    blinkUntil = now + 150;
  }
  if (blinkUntil > 0 && now > blinkUntil) {
    blinkUntil = 0;
    nextBlinkAt = now + 3000 + Math.random() * 3000;
  }
  // 换重心：仅在 Working/Focused 时（干活中调整坐姿）
  const expr = currentPayload.expression;
  if ((expr === "Working" || expr === "Focused") && shiftUntil === 0 && now >= nextShiftAt) {
    shiftX = Math.random() < 0.5 ? -1 : 1;
    shiftUntil = now + 2000;
  }
  if (shiftUntil > 0 && now > shiftUntil) {
    shiftX = 0;
    shiftUntil = 0;
    nextShiftAt = now + 8000 + Math.random() * 6000;
  }
}

/** 是否正在眨眼 */
function isBlinking(now) {
  return blinkUntil > 0 && now < blinkUntil;
}

function computeBounce(kind, t) {
  switch (kind) {
    case "slow":
      return { dx: 0, dy: Math.sin(t * Math.PI) * 1.5 };
    case "fast":
      return { dx: 0, dy: Math.abs(Math.sin(t * Math.PI * 6)) * -3 };
    case "random":
      return { dx: (Math.random() - 0.5) * 2, dy: (Math.random() - 0.5) * 2 };
    default:
      return { dx: 0, dy: 0 };
  }
}

function rgbToHueRotate([r, g, b]) {
  if (r > g && r > b) return r > 150 ? 0 : 30;
  if (b > r && b > g) return g > 100 ? 200 : 250;
  if (g > r && g > b) return 90;
  if (r > 180 && g > 180) return 50;
  return 0;
}

/**
 * 默认像素打工仔（无用户图时兜底）。
 * 含打工细节：工牌/领带/汗滴/黑眼圈/腮红（按表情触发）。
 */
function drawDefaultPet(expression, t, now) {
  const breath = Math.round(Math.sin(t * Math.PI)) | 0; // 呼吸 0/1
  const blinking = isBlinking(now);

  // Office 灰调
  const SKIN = "#f1c27d";
  const SHIRT = "#4b5563";
  const TIE = "#7f1d1d"; // 暗红领带
  const BADGE = "#fef3c7"; // 米白领牌
  const DARK = "#1f2937";
  const WHITE = "#ffffff";

  const headX = -8;
  const headY = -22 + breath;
  const bodyX = -10;
  const bodyY = -8 + breath;

  // 身体（衬衫）
  ctx.fillStyle = SHIRT;
  ctx.fillRect(bodyX, bodyY, 20, 18);

  // 领带（从领口向下）
  ctx.fillStyle = TIE;
  ctx.fillRect(-1, bodyY + 2, 2, 10);

  // 工牌（左胸）：白底 + 黑边框（用四条线画边框，避免 strokeStyle 混淆）
  ctx.fillStyle = BADGE;
  ctx.fillRect(bodyX + 2, bodyY + 4, 4, 4);
  ctx.fillStyle = DARK;
  ctx.fillRect(bodyX + 2, bodyY + 4, 4, 1); // 上边
  ctx.fillRect(bodyX + 2, bodyY + 7, 4, 1); // 下边
  ctx.fillRect(bodyX + 2, bodyY + 4, 1, 4); // 左边
  ctx.fillRect(bodyX + 5, bodyY + 4, 1, 4); // 右边
  // 工牌内一个小点（照片占位）
  ctx.fillRect(bodyX + 3, bodyY + 5, 2, 1);

  // 领口
  ctx.fillStyle = WHITE;
  ctx.fillRect(-2, bodyY, 4, 2);

  // 头
  ctx.fillStyle = SKIN;
  ctx.fillRect(headX, headY, 16, 14);

  // 头发
  ctx.fillStyle = DARK;
  ctx.fillRect(headX, headY, 16, 3);

  // 黑眼圈（NightShift/Tired/Overworked）
  if (expression === "NightShift" || expression === "Tired" || expression === "Overworked") {
    ctx.fillStyle = "rgba(76, 29, 149, 0.4)"; // 紫黑眼圈
    ctx.fillRect(headX + 2, headY + 7, 5, 2);
    ctx.fillRect(headX + 9, headY + 7, 5, 2);
  }

  // 腮红（Happy/Excited）
  if (expression === "Happy" || expression === "Excited") {
    ctx.fillStyle = "rgba(244, 114, 182, 0.6)"; // 粉
    ctx.fillRect(headX + 1, headY + 8, 2, 2);
    ctx.fillRect(headX + 13, headY + 8, 2, 2);
  }

  // 眼睛 + 嘴（按表情；眨眼时画一线）
  drawFace(expression, headX, headY, blinking);

  // 汗滴（Tired/Overworked/Excited）
  if (expression === "Tired" || expression === "Overworked" || expression === "Excited") {
    ctx.fillStyle = "#60a5fa"; // 蓝汗滴
    ctx.fillRect(headX + 13, headY - 3, 2, 3);
    ctx.fillRect(headX + 14, headY - 1, 1, 1);
  }

  // 手
  ctx.fillStyle = SKIN;
  ctx.fillRect(bodyX - 2, bodyY + 6, 3, 6);
  ctx.fillRect(bodyX + 19, bodyY + 6, 3, 6);
}

/** 按表情画眼睛和嘴。眨眼时画一条横线代替眼睛。 */
function drawFace(expression, hx, hy, blinking) {
  const DARK = "#1f2937";
  const eyeY = hy + 6;
  const leftEyeX = hx + 3;
  const rightEyeX = hx + 10;

  if (blinking) {
    // 眨眼：两条短线
    ctx.fillStyle = DARK;
    ctx.fillRect(leftEyeX, eyeY + 1, 3, 1);
    ctx.fillRect(rightEyeX, eyeY + 1, 3, 1);
    ctx.fillRect(hx + 6, hy + 11, 4, 1); // 嘴保持
    return;
  }

  switch (expression) {
    case "Exhausted":
      ctx.fillStyle = DARK;
      drawX(leftEyeX, eyeY);
      drawX(rightEyeX, eyeY);
      ctx.fillRect(hx + 6, hy + 10, 4, 3); // O 嘴
      break;
    case "Tired":
    case "Overworked":
      ctx.fillStyle = DARK;
      ctx.fillRect(leftEyeX, eyeY + 1, 3, 1);
      ctx.fillRect(rightEyeX, eyeY + 1, 3, 1);
      ctx.fillRect(hx + 5, hy + 11, 1, 1);
      ctx.fillRect(hx + 7, hy + 10, 1, 1);
      ctx.fillRect(hx + 9, hy + 11, 1, 1);
      break;
    case "Happy":
    case "Excited":
      ctx.fillStyle = DARK;
      ctx.fillRect(leftEyeX + 1, eyeY, 1, 1);
      ctx.fillRect(leftEyeX, eyeY + 1, 3, 1);
      ctx.fillRect(rightEyeX + 1, eyeY, 1, 1);
      ctx.fillRect(rightEyeX, eyeY + 1, 3, 1);
      ctx.fillRect(hx + 5, hy + 10, 1, 1);
      ctx.fillRect(hx + 6, hy + 11, 4, 1);
      ctx.fillRect(hx + 10, hy + 10, 1, 1);
      break;
    default:
      ctx.fillStyle = DARK;
      ctx.fillRect(leftEyeX, eyeY, 3, 3);
      ctx.fillRect(rightEyeX, eyeY, 3, 3);
      ctx.fillRect(hx + 6, hy + 11, 4, 1);
  }
}

function drawX(x, y) {
  ctx.fillStyle = "#1f2937";
  ctx.fillRect(x, y, 1, 1);
  ctx.fillRect(x + 2, y, 1, 1);
  ctx.fillRect(x + 1, y + 1, 1, 1);
  ctx.fillRect(x, y + 2, 1, 1);
  ctx.fillRect(x + 2, y + 2, 1, 1);
}

// ===== 冒泡系统（红线 1：只反应不教育，3 秒消失；冷却 + 权重） =====
const bubbleEl = document.getElementById("bubble");
const BUBBLE_LINES = {
  Working: ["需求好急", "这个 bug 改不完", "再撑一下"],
  Tired: ["眼皮好沉", "撑不住了", "几点了"],
  Exhausted: ["我废了", "需要躺一会"],
  Overworked: ["不行了", "救护车…", "到极限了"],
  Idle: ["带薪摸鱼", "老板没在看", "我瘫一会儿"],
  NightShift: ["zzZ", "夜班双倍，值了", "天怎么亮了"],
  Excited: ["冲冲冲", "需求好急！", "今天状态不错"],
  Focused: ["别打扰我", "进入心流了"],
  Chaotic: ["甲方又改需求", "我在切哪个窗口", "信息过载"],
  Happy: ["交付了！", "终于能睡了", "下班！"],
};

// 重要状态高触发率，常态低触发率
const BUBBLE_WEIGHT = {
  Exhausted: 0.8,
  Overworked: 0.8,
  Happy: 0.8,
  Tired: 0.5,
  NightShift: 0.5,
  Excited: 0.5,
  Working: 0.3,
  Idle: 0.3,
  Focused: 0.3,
  Chaotic: 0.5,
};

let bubbleTimer = null;
let lastBubbleText = "";
let lastBubbleTime = 0;
const BUBBLE_COOLDOWN = 30000; // 同文案 30 秒冷却

function showBubble(expression, forceText = null) {
  const lines = BUBBLE_LINES[expression];
  if (!lines || lines.length === 0) return;
  const now = Date.now();

  let text = forceText;
  if (!text) {
    // 冷却：同文案 30 秒内不重复
    const available = lines.filter((l) => !(l === lastBubbleText && now - lastBubbleTime < BUBBLE_COOLDOWN));
    const pool = available.length > 0 ? available : lines;
    text = pool[Math.floor(Math.random() * pool.length)];
  }

  bubbleEl.textContent = text;
  bubbleEl.classList.add("show");
  lastBubbleText = text;
  lastBubbleTime = now;

  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubbleEl.classList.remove("show"), 3000);
}

// ===== 事件监听 =====
listen("expression-changed", (event) => {
  const p = event.payload;
  currentPayload = {
    expression: p.expression,
    brightness: p.brightness,
    rotation: p.rotation,
    opacity: p.opacity,
    tint: p.tint,
    bounce: p.bounce,
  };
  // 按权重随机触发冒泡
  const weight = BUBBLE_WEIGHT[p.expression] ?? 0.3;
  if (Math.random() < weight) {
    showBubble(p.expression);
  }
});

// 后端主动冒泡（如"关于"菜单）
listen("bubble-show", (event) => {
  if (typeof event.payload === "string") {
    showBubble(currentPayload.expression, event.payload);
  }
});

// 菜单"暂时消失1小时"事件 → 调用隐藏 command
listen("menu/hide-1h", () => {
  invoke("hide_for_one_hour").catch((e) => console.error("hide", e));
});

// 启动渲染
requestAnimationFrame(render);
