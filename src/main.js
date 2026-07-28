// Overworked 前端 —— 桌宠像素打工仔 渲染引擎
//
// 设计红线（见 overworked_design_principles）：
// - 红线 1（不爹味）：冒泡只反应不教育，3 秒消失
// - 红线 2（不暴露数值）：前端只收 ExpressionPayload（渲染指令），
//   永远拿不到体力/心情/存款。payload 里的亮度/旋转是"画多亮"，不是数值。
// - 红线 3（不抢焦点）：不弹窗，冒泡不打断
//
// 渲染策略：requestAnimationFrame 持续渲染，每帧应用 payload 指定的特效。
// "一张图变桌宠"：优先加载用户图 (assets/pet.png)，失败则画默认像素小人。

const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

const canvas = document.getElementById("pet");
const ctx = canvas.getContext("2d");
ctx.imageSmoothingEnabled = false; // 像素感

// ===== 状态：当前表情的表现层指令（从后端接收，默认 Working） =====
let currentPayload = {
  expression: "Working",
  brightness: 1.0,
  rotation: 0.0,
  opacity: 1.0,
  tint: null,
  bounce: "none",
};

// ===== 用户图加载（"一张图变桌宠"主路径） =====
// MVP 先写死路径 assets/pet.png。用户把图放这里即可生效。
// 加载失败/无图 → 走 drawDefaultPet 兜底。
let petImage = null;
const img = new Image();
img.onload = () => {
  petImage = img;
  console.debug("[pet] 用户图加载成功");
};
img.onerror = () => {
  console.debug("[pet] 无用户图，使用默认像素小人");
};
img.src = "assets/pet.png";

// ===== 渲染主循环 =====
function render(now) {
  const t = now / 1000; // 秒

  // 根据抖动模式计算本帧偏移
  const { dx, dy } = computeBounce(currentPayload.bounce, t);

  // 清空（透明）
  ctx.clearRect(0, 0, 96, 96);
  ctx.globalAlpha = currentPayload.opacity;

  // 应用滤镜：亮度 + 色调（用 hue-rotate 模拟）
  const filterParts = [];
  if (currentPayload.brightness !== 1.0) {
    filterParts.push(`brightness(${currentPayload.brightness})`);
  }
  if (currentPayload.tint) {
    // tint 是 RGB，用 sepia + hue-rotate 近似上色
    filterParts.push("sepia(1) saturate(2)");
    filterParts.push(`hue-rotate(${rgbToHueRotate(currentPayload.tint)}deg)`);
  }
  ctx.filter = filterParts.join(" ") || "none";

  // 居中 + 旋转 + 抖动偏移
  ctx.save();
  ctx.translate(48 + dx, 48 + dy);
  ctx.rotate(currentPayload.rotation);

  if (petImage) {
    // 用户图：画在中心，最大 64×64，保持比例
    const size = 64;
    ctx.drawImage(petImage, -size / 2, -size / 2, size, size);
  } else {
    // 默认像素小人
    drawDefaultPet(currentPayload.expression, t);
  }
  ctx.restore();

  // 重置
  ctx.filter = "none";
  ctx.globalAlpha = 1.0;

  requestAnimationFrame(render);
}

/**
 * 计算抖动偏移。不同模式不同节奏：
 * - slow: ~2秒周期，呼吸式，小幅度
 * - fast: ~0.3秒周期，跳动式，大幅度
 * - random: 随机抖动
 */
function computeBounce(kind, t) {
  switch (kind) {
    case "slow": {
      // 呼吸：正弦波，幅度 1.5px
      const dy = Math.sin(t * Math.PI) * 1.5;
      return { dx: 0, dy };
    }
    case "fast": {
      // 跳动：高频正弦，幅度 3px
      const dy = Math.abs(Math.sin(t * Math.PI * 6)) * -3;
      return { dx: 0, dy };
    }
    case "random": {
      // 随机：每帧 ±1px
      return { dx: (Math.random() - 0.5) * 2, dy: (Math.random() - 0.5) * 2 };
    }
    default:
      return { dx: 0, dy: 0 };
  }
}

/** RGB tint 转 hue-rotate 角度（粗略映射，够用） */
function rgbToHueRotate([r, g, b]) {
  // 简化：按主色调映射到大致色相
  if (r > g && r > b) return r > 150 ? 0 : 30; // 红/橙
  if (b > r && b > g) return g > 100 ? 200 : 250; // 蓝/紫
  if (g > r && g > b) return 90; // 绿
  if (r > 180 && g > 180) return 50; // 黄
  return 0; // 灰
}

/**
 * 默认像素打工仔（无用户图时的 fallback）。
 * 画在 (0,0) 中心坐标系（调用前已 translate 到画布中心）。
 * 约 40×48 的方块拼接小人 + 2 帧呼吸动画。
 */
function drawDefaultPet(expression, t) {
  // 呼吸：身体上下 1px，约 2 秒一周期
  const breath = Math.round(Math.sin(t * Math.PI)) | 0; // 0 或 1（像素级量化）

  // 颜色：办公室灰调（PRD 4.1）
  const SKIN = "#f1c27d";
  const SHIRT = "#4b5563"; // 深灰衬衫
  const DARK = "#1f2937";
  const WHITE = "#ffffff";

  // 坐标系：中心 (0,0)，角色约 40 宽 × 48 高
  // 头：16×14，居中偏上
  const headX = -8;
  const headY = -22 + breath;
  // 身：20×18，头下方
  const bodyX = -10;
  const bodyY = -8 + breath;

  // —— 身体（衬衫） ——
  ctx.fillStyle = SHIRT;
  ctx.fillRect(bodyX, bodyY, 20, 18);
  // 领口
  ctx.fillStyle = WHITE;
  ctx.fillRect(-2, bodyY, 4, 4);

  // —— 头 ——
  ctx.fillStyle = SKIN;
  ctx.fillRect(headX, headY, 16, 14);

  // —— 头发（深色顶） ——
  ctx.fillStyle = DARK;
  ctx.fillRect(headX, headY, 16, 3);

  // —— 眼睛 + 嘴（按表情变化） ——
  drawFace(expression, headX, headY);

  // —— 手（搭在身前） ——
  ctx.fillStyle = SKIN;
  ctx.fillRect(bodyX - 2, bodyY + 6, 3, 6);
  ctx.fillRect(bodyX + 19, bodyY + 6, 3, 6);
}

/** 按表情画眼睛和嘴（让默认小人也能传达状态） */
function drawFace(expression, hx, hy) {
  const DARK = "#1f2937";
  const WHITE = "#ffffff";

  // 眼睛基础位置
  const eyeY = hy + 6;
  const leftEyeX = hx + 3;
  const rightEyeX = hx + 10;

  switch (expression) {
    case "Exhausted":
      // X X 眼（瘫倒）
      ctx.fillStyle = DARK;
      drawX(leftEyeX, eyeY);
      drawX(rightEyeX, eyeY);
      // 嘴：张开的 O
      ctx.fillRect(hx + 6, hy + 10, 4, 3);
      break;
    case "Tired":
    case "Overworked":
      // — — 眼（疲惫）
      ctx.fillStyle = DARK;
      ctx.fillRect(leftEyeX, eyeY + 1, 3, 1);
      ctx.fillRect(rightEyeX, eyeY + 1, 3, 1);
      // 嘴：波浪（用几个点近似）
      ctx.fillRect(hx + 5, hy + 11, 1, 1);
      ctx.fillRect(hx + 7, hy + 10, 1, 1);
      ctx.fillRect(hx + 9, hy + 11, 1, 1);
      break;
    case "Happy":
    case "Excited":
      // ^ ^ 眼（开心）
      ctx.fillStyle = DARK;
      ctx.fillRect(leftEyeX + 1, eyeY, 1, 1);
      ctx.fillRect(leftEyeX, eyeY + 1, 3, 1);
      ctx.fillRect(rightEyeX + 1, eyeY, 1, 1);
      ctx.fillRect(rightEyeX, eyeY + 1, 3, 1);
      // 嘴：微笑
      ctx.fillRect(hx + 5, hy + 10, 1, 1);
      ctx.fillRect(hx + 6, hy + 11, 4, 1);
      ctx.fillRect(hx + 10, hy + 10, 1, 1);
      break;
    default:
      // 正常圆点眼 + 一字嘴
      ctx.fillStyle = DARK;
      ctx.fillRect(leftEyeX, eyeY, 3, 3);
      ctx.fillRect(rightEyeX, eyeY, 3, 3);
      ctx.fillRect(hx + 6, hy + 11, 4, 1);
  }
}

/** 画一个像素 X（3×3） */
function drawX(x, y) {
  const DARK = "#1f2937";
  ctx.fillStyle = DARK;
  ctx.fillRect(x, y, 1, 1);
  ctx.fillRect(x + 2, y, 1, 1);
  ctx.fillRect(x + 1, y + 1, 1, 1);
  ctx.fillRect(x, y + 2, 1, 1);
  ctx.fillRect(x + 2, y + 2, 1, 1);
}

// ===== 冒泡系统（红线 1：只反应不教育，3 秒消失） =====
const bubbleEl = document.getElementById("bubble");

// 冒泡文案池（按表情分类，呼应 overworked_game_loop）
// 守红线 5（反差是灵魂）：心酸 > 正确，可截图
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

let bubbleTimer = null;
function showBubble(expression) {
  const lines = BUBBLE_LINES[expression];
  if (!lines || lines.length === 0) return;
  const text = lines[Math.floor(Math.random() * lines.length)];
  bubbleEl.textContent = text;
  bubbleEl.classList.add("show");
  // 红线 3：3 秒自动消失，不打断
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => {
    bubbleEl.classList.remove("show");
  }, 3000);
}

// ===== 事件监听 =====
// 表情变化：更新 payload（渲染指令），并触发冒泡
listen("expression-changed", (event) => {
  const p = event.payload;
  currentPayload = {
    expression: p.expression,
    brightness: p.brightness,
    rotation: p.rotation,
    opacity: p.opacity,
    tint: p.tint, // 可能是 null
    bounce: p.bounce,
  };
  // 随机触发冒泡（不是每次表情变都冒，避免太吵）
  if (Math.random() < 0.5) {
    showBubble(p.expression);
  }
});

// 冒泡事件（后端可主动触发的冒泡，MVP 暂未用，留接口）
listen("bubble-show", (event) => {
  if (typeof event.payload === "string") {
    bubbleEl.textContent = event.payload;
    bubbleEl.classList.add("show");
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubbleEl.classList.remove("show"), 3000);
  }
});

// 点击它一下 → "哎！"（双击触发，因 -webkit-app-region: drag 吞单击）
canvas.addEventListener("dblclick", () => {
  invoke("poke_pet").catch((e) => console.error("poke failed", e));
});

// 启动渲染循环
requestAnimationFrame(render);
