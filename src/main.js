// Overworked 前端 —— 皮肤系统播放器
//
// 架构（"约定大于配置"）：
//   skins/<皮肤名>/<动作>/1.png 2.png...  ← 用户按命名放图即可
//   Rust 扫描目录 → list_skins 返回结构 → 前端加载帧 → 播放
//
// 动作分两类：
//   状态动作（idle/working/tired/...）：循环播放，由 ExpressionPayload 驱动
//   一次性动作（poke/drag/walk/jump）：播放完回当前状态
//
// 红线守护：
// - 红线 1：冒泡只反应不教育，3 秒消失
// - 红线 2：前端只收渲染指令，拿不到体力/心情/存款
// - 红线 3：不弹窗，右键菜单极简

const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const win = getCurrentWindow();

const canvas = document.getElementById("pet");
const ctx = canvas.getContext("2d");
ctx.imageSmoothingEnabled = false;

// ===== 状态映射：Expression → 动作名 =====
// 不在表里的表情 fallback 到 idle（交互动作不走这个映射）
const EXPR_TO_ACTION = {
  Working: "working",
  Idle: "idle",
  Tired: "tired",
  Exhausted: "exhausted",
  Overworked: "overworked",
  NightShift: "nightshift",
  Happy: "happy",
  Excited: "working", // Excited 没有专属动作，用 working
  Focused: "working",
  Chaotic: "working",
};

// ===== 皮肤数据 =====
let currentSkin = "default";
let skinInfo = null; // { name, actions: { idle: {frames:3}, ... } }
let frameCache = {}; // { "idle": [Image, Image, ...], "working": [...], ... }

/** 加载一个皮肤的所有帧（通过 Rust 读文件转 base64） */
async function loadSkin(skinName) {
  const skins = await invoke("list_skins");
  const info = skins.find((s) => s.name === skinName) || skins[0];
  if (!info) {
    console.error("无可用皮肤");
    return;
  }
  skinInfo = info;
  currentSkin = info.name;
  frameCache = {};

  // 并行加载所有动作的所有帧
  const tasks = [];
  for (const [action, meta] of Object.entries(info.actions)) {
    frameCache[action] = [];
    for (let f = 1; f <= meta.frames; f++) {
      const idx = f - 1;
      tasks.push(
        invoke("read_skin_frame", { skin: info.name, action, frame: f }).then((dataUrl) => {
          if (dataUrl) {
            const img = new Image();
            img.src = dataUrl;
            frameCache[action][idx] = img;
          }
        })
      );
    }
  }
  await Promise.all(tasks);
  console.log(`[skin] 加载皮肤 ${info.name}：${Object.keys(info.actions).length} 个动作`);
}

/** 取某动作的帧序列（缺失 fallback 到 idle） */
function getFrames(action) {
  return frameCache[action] || frameCache.idle || [];
}

// ===== 动作状态机 =====
let currentState = "idle"; // 当前状态动作（由 ExpressionPayload 驱动）
let oneShotAction = null; // 当前一次性动作（poke/drag/walk/jump），null=无
let oneShotFrame = 0;
let oneShotLoop = 0; // 当前一次性动作已播放的轮数
let stateFrame = 0;
let lastFrameTime = 0;
const FRAME_INTERVAL = 200; // 5 fps，稍快让动作更流畅

// 一次性动作的播放轮数（让 walk/jump 持续够久能看清）
const ONE_SHOT_LOOPS = {
  poke: 1,
  drag: 999, // 持续到 mouseup
  walk: 3,
  jump: 2,
};

// 一次性动作触发
function triggerOneShot(action) {
  const frames = getFrames(action);
  if (frames.length === 0) {
    console.warn("[action] 动作无帧:", action);
    return;
  }
  oneShotAction = action;
  oneShotFrame = 0;
  oneShotLoop = 0;
  lastFrameTime = performance.now();
}

// 按住类动作（poke/drag）：触发后循环播放，直到 endHoldAction
// 复用 oneShotAction 机制，但标记为 hold，渲染时不计入轮数
let holdAction = false;
function triggerHoldAction(action) {
  const frames = getFrames(action);
  if (frames.length === 0) return;
  oneShotAction = action;
  oneShotFrame = 0;
  holdAction = true; // 标记：不按轮数结束，等 endHoldAction
  lastFrameTime = performance.now();
}
function endHoldAction() {
  if (holdAction) {
    oneShotAction = null;
    holdAction = false;
  }
}

// ===== walk：窗口平移 + 侧面动画 =====
// walk 触发时，窗口在屏幕上左右平移，角色播侧面走路帧。
// 走到一定距离后反向，持续若干秒后回状态。
let walkTimer = null;
let walkDir = 1; // 1=向右, -1=向左

async function startWalking() {
  const frames = getFrames("walk");
  if (frames.length === 0) return;
  // 设为持续动作（hold 模式，循环播放侧面帧）
  oneShotAction = "walk";
  oneShotFrame = 0;
  holdAction = true;
  lastFrameTime = performance.now();

  // 随机初始方向
  walkDir = Math.random() < 0.5 ? 1 : -1;

  // 窗口平移：每 80ms 移动 4 像素，走约 3 秒后停
  const SPEED = 4; // 每次移动像素
  const INTERVAL = 80;
  const DURATION = 3000; // 走 3 秒
  const MAX_OFFSET = 120; // 单方向最大偏移
  let offset = 0;
  const startTime = performance.now();

  // 先记录起始位置
  let basePos;
  try {
    basePos = await win.outerPosition();
  } catch (e) {
    console.error("walk: 获取位置失败", e);
    return;
  }

  // 物理坐标的缩放因子（DPI）
  const scaleFactor = await win.scaleFactor().catch(() => 1);

  walkTimer = setInterval(async () => {
    if (performance.now() - startTime > DURATION) {
      stopWalking();
      return;
    }
    offset += walkDir * SPEED;
    // 到达边界反向
    if (Math.abs(offset) > MAX_OFFSET) {
      walkDir *= -1;
      offset += walkDir * SPEED;
    }
    try {
      // 用物理坐标直接设（outerPosition 返回物理坐标）
      const physX = basePos.x + Math.round(offset * scaleFactor);
      const physY = basePos.y;
      const { PhysicalPosition } = window.__TAURI__.window;
      await win.setPosition(new PhysicalPosition(physX, physY));
    } catch (e) {
      console.error("walk move", e);
    }
  }, INTERVAL);
}

function stopWalking() {
  if (walkTimer) {
    clearInterval(walkTimer);
    walkTimer = null;
  }
  endHoldAction(); // 结束 walk 动画，回状态
}

// 随机生动动作（walk/jump）的下次触发时间
let nextAmbient = performance.now() + 15000 + Math.random() * 15000;

// ===== ExpressionPayload（叠加特效，从后端接收） =====
let currentPayload = {
  expression: "Working",
  brightness: 1.0,
  rotation: 0.0,
  opacity: 1.0,
  tint: null,
  bounce: "none",
};

// ===== 交互：单击 poke / 拖动分离 =====
// 拖动用 Tauri startDragging（原生窗口拖动）；poke 是短按未移动。
// 关键：startDragging 后 Tauri 接管鼠标，后续 mousemove/mouseup 可能收不到，
// 所以一旦判定为拖动就立即 return，不再依赖后续事件。
let mouseDown = null;
canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  mouseDown = { x: e.screenX, y: e.screenY, t: performance.now(), dragged: false };
  // 按下即触发 poke 持续动作（按住保持，松开结束）
  triggerHoldAction("poke");
});

canvas.addEventListener("mousemove", (e) => {
  if (!mouseDown || mouseDown.dragged) return;
  const dx = e.screenX - mouseDown.x;
  const dy = e.screenY - mouseDown.y;
  if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
    // 移动超过阈值 → 切换为拖动
    mouseDown.dragged = true;
    endHoldAction(); // 结束 poke
    // 先启动 drag 持续动画（挣扎姿态），再 startDragging
    // 时序关键：drag 动作设好后，渲染循环会持续播 drag 帧，
    // 即使 startDragging 接管鼠标也不影响（动画由 RAF 驱动，不依赖鼠标事件）
    triggerHoldAction("drag");
    win.startDragging();
  }
});

canvas.addEventListener("mouseup", (e) => {
  if (e.button !== 0) return;
  // 松开 → 结束 poke/drag，回当前状态
  endHoldAction();
  mouseDown = null;
});

canvas.addEventListener("mouseleave", () => {
  // 鼠标离开也结束（避免卡住）
  endHoldAction();
  mouseDown = null;
});

// ===== 右键菜单 =====
canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  invoke("show_context_menu").catch((err) => console.error("menu", err));
});

// ===== 渲染主循环 =====
function render(now) {
  // 帧推进
  if (now - lastFrameTime >= FRAME_INTERVAL) {
    lastFrameTime = now;

    if (oneShotAction) {
      const frames = getFrames(oneShotAction);
      oneShotFrame++;
      if (oneShotFrame >= frames.length) {
        if (holdAction) {
          // 按住类动作（poke）：循环播放，不结束
          oneShotFrame = 0;
        } else {
          // 一次性动作：按轮数结束
          const maxLoops = ONE_SHOT_LOOPS[oneShotAction] ?? 1;
          oneShotLoop++;
          if (oneShotLoop >= maxLoops) {
            oneShotAction = null;
          } else {
            oneShotFrame = 0;
          }
        }
      }
    } else {
      // 状态动作：循环推进
      const frames = getFrames(currentState);
      if (frames.length > 0) {
        stateFrame = (stateFrame + 1) % frames.length;
      }
    }
  }

  // 随机触发 walk/jump（无一次性动作时）
  if (!oneShotAction && !holdAction && now >= nextAmbient) {
    if (Math.random() < 0.5) {
      startWalking(); // walk：窗口平移 + 侧面动画
    } else {
      triggerOneShot("jump");
    }
    nextAmbient = now + 15000 + Math.random() * 20000;
  }

  // 决定当前要画的帧
  let imgToDraw = null;
  if (oneShotAction) {
    const frames = getFrames(oneShotAction);
    imgToDraw = frames[Math.min(oneShotFrame, frames.length - 1)];
  } else {
    const frames = getFrames(currentState);
    imgToDraw = frames[stateFrame % Math.max(1, frames.length)];
  }

  // 渲染
  ctx.clearRect(0, 0, 96, 96);
  ctx.globalAlpha = currentPayload.opacity;

  // 叠加特效（仅状态动作期间；一次性动作暂停特效，动作本身已表达情绪）
  let filterStr = "none";
  let bounceDx = 0;
  let bounceDy = 0;
  if (!oneShotAction) {
    const filterParts = [];
    if (currentPayload.brightness !== 1.0) {
      filterParts.push(`brightness(${currentPayload.brightness})`);
    }
    if (currentPayload.tint) {
      filterParts.push("sepia(1) saturate(2)");
      filterParts.push(`hue-rotate(${rgbToHueRotate(currentPayload.tint)}deg)`);
    }
    filterStr = filterParts.join(" ") || "none";
    const b = computeBounce(currentPayload.bounce, now / 1000);
    bounceDx = b.dx;
    bounceDy = b.dy;
  }
  ctx.filter = filterStr;

  if (imgToDraw && imgToDraw.complete && imgToDraw.naturalWidth > 0) {
    ctx.save();
    ctx.translate(48 + bounceDx, 48 + bounceDy);
    // walk 朝左时水平镜像（一套朝右帧，双向走）
    if (oneShotAction === "walk" && walkDir < 0) {
      ctx.scale(-1, 1);
    }
    if (!oneShotAction) {
      ctx.rotate(currentPayload.rotation); // 一次性动作不旋转
    }
    // 32×32 放大到 64×64 居中
    ctx.drawImage(imgToDraw, -32, -32, 64, 64);
    ctx.restore();
  } else {
    // 帧未加载完，画占位
    ctx.fillStyle = "#6b7280";
    ctx.fillRect(16, 16, 64, 64);
  }

  ctx.filter = "none";
  ctx.globalAlpha = 1.0;

  requestAnimationFrame(render);
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

// ===== 冒泡系统 =====
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
const BUBBLE_COOLDOWN = 30000;

function showBubble(expression, forceText = null) {
  const lines = BUBBLE_LINES[expression];
  if (!lines || lines.length === 0) return;
  const now = Date.now();
  let text = forceText;
  if (!text) {
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
  // 状态动作切换（不打断一次性动作；预览模式期间不覆盖）
  const newAction = EXPR_TO_ACTION[p.expression] || "idle";
  const inPreview = performance.now() < previewUntil;
  if (!inPreview) {
    if (newAction !== currentState && !oneShotAction) {
      currentState = newAction;
      stateFrame = 0;
    } else if (oneShotAction) {
      currentState = newAction;
    }
  }
  const weight = BUBBLE_WEIGHT[p.expression] ?? 0.3;
  if (Math.random() < weight) showBubble(p.expression);
});

listen("bubble-show", (event) => {
  if (typeof event.payload === "string") {
    showBubble(currentPayload.expression, event.payload);
  }
});

listen("menu/hide-1h", () => {
  invoke("hide_for_one_hour").catch((e) => console.error("hide", e));
});

// 换皮肤（右键菜单触发）
listen("skin-switched", async (event) => {
  const skinName = event.payload;
  await loadSkin(skinName);
  stateFrame = 0;
});

// 动作预览（右键菜单"动作预览"手动触发）
const STATE_ACTIONS = ["idle", "working", "tired", "exhausted", "overworked", "nightshift", "happy"];
let previewUntil = 0; // 预览模式结束时间，期间真实感知不覆盖状态
listen("preview-action", (event) => {
  const action = event.payload;
  // 先清掉当前的一次性/按住动作
  endHoldAction();
  oneShotAction = null;

  if (STATE_ACTIONS.includes(action)) {
    // 状态动作：切换并冻结 15 秒（方便观察），期间真实感知不覆盖
    currentState = action;
    stateFrame = 0;
    previewUntil = performance.now() + 15000;
  } else if (action === "walk") {
    startWalking();
  } else if (action === "poke") {
    triggerHoldAction("poke");
  } else {
    // jump 等一次性动作
    triggerOneShot(action);
  }
});

// ===== 启动（顶层 await，target=esnext 支持） =====
await loadSkin("default");
requestAnimationFrame(render);
