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
            img.onload = () => { frameCache[action][idx] = img; };
            img.onerror = () => { console.warn(`[skin] 帧加载失败: ${action}/${f}`); };
            img.src = dataUrl;
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
  // 事件动作多播几轮，让人看清标志性元素
  payday: 4,
  teambuilding: 4,
  promoted: 4,
  leave: 2,
  return: 3,
  happy: 2,
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
  endHoldAction();
}

// ===== 桌面物理交互：掉落 + 底边走（Shimeji 式）=====
// 简单物理：拖到空中松开 → 掉到底边 + 弹跳 + 走边
// 拖动结束由 Rust 侧 WindowEvent::Moved debounce 检测，emit "drag-ended"
const WIN_W = 160;
const WIN_H = 200;

let physicsTimer = null;

/** 拖动结束后检测：若悬空（离底边>50px）则掉落 */
async function startFallIfNeeded() {
  if (physicsTimer) return;
  const monitor = await window.__TAURI__.window.currentMonitor().catch(() => null);
  if (!monitor) return;
  const screenH = monitor.size.height;
  const scaleFactor = monitor.scaleFactor;
  let pos;
  try {
    pos = await win.outerPosition();
  } catch {
    return;
  }
  const winH_phys = Math.round(WIN_H * scaleFactor);
  const bottomGap = screenH - (pos.y + winH_phys);
  if (bottomGap > 50) {
    doFall(screenH, scaleFactor);
  }
}

/** 真正执行掉落（重力下落 + 弹跳 + 落地走边） */
async function doFall(screenH, scaleFactor) {
  const screenW = (await window.__TAURI__.window.currentMonitor().catch(() => null))?.size.width || 1920;
  let pos;
  try {
    pos = await win.outerPosition();
  } catch {
    return;
  }
  let y = pos.y;
  const startX = pos.x;
  let vy = 0;
  const gravity = 2.5;
  const groundY = screenH - Math.round(WIN_H * scaleFactor);
  let bounces = 0;
  const maxBounces = 2;

  triggerHoldAction("drag"); // 掉落挣扎

  physicsTimer = setInterval(async () => {
    vy += gravity;
    y += vy;
    if (y >= groundY) {
      y = groundY;
      if (bounces < maxBounces && vy > 8) {
        vy = -Math.round(vy * 0.4);
        bounces++;
      } else {
        clearInterval(physicsTimer);
        physicsTimer = null;
        try {
          const { PhysicalPosition } = window.__TAURI__.window;
          await win.setPosition(new PhysicalPosition(startX, groundY));
        } catch {}
        invoke("save_window_pos").catch(() => {});
        endHoldAction();
        strollOnGround(startX, groundY, screenW, scaleFactor);
      }
    }
    try {
      const { PhysicalPosition } = window.__TAURI__.window;
      await win.setPosition(new PhysicalPosition(startX, Math.round(y)));
    } catch {}
  }, 16);
}

/** 落地后沿底边左右走一段 */
function strollOnGround(startX, groundY, screenW, scaleFactor) {
  const dir = Math.random() < 0.5 ? 1 : -1;
  const distance = Math.round((80 + Math.random() * 120) * scaleFactor);
  let x = startX;
  let traveled = 0;

  walkDir = dir;
  triggerHoldAction("walk");

  physicsTimer = setInterval(async () => {
    const step = Math.round(3 * scaleFactor);
    x += dir * step;
    traveled += step;
    if (x < 0 || x > screenW - WIN_W * scaleFactor || traveled > distance) {
      clearInterval(physicsTimer);
      physicsTimer = null;
      endHoldAction();
      invoke("save_window_pos").catch(() => {});
      return;
    }
    try {
      const { PhysicalPosition } = window.__TAURI__.window;
      await win.setPosition(new PhysicalPosition(x, groundY));
    } catch {}
  }, 60);
}

// ===== 拖动结束检测（轮询法）=====
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
// 拖动：左键=移位（不掉）。掉落走右键菜单「掉下去」。
// poke：左键短按未移动。
let mouseDown = null;

canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  mouseDown = { x: e.screenX, y: e.screenY, t: performance.now(), dragged: false };
  triggerHoldAction("poke");
});

canvas.addEventListener("mousemove", (e) => {
  if (!mouseDown || mouseDown.dragged) return;
  const dx = e.screenX - mouseDown.x;
  const dy = e.screenY - mouseDown.y;
  if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
    mouseDown.dragged = true;
    endHoldAction();
    triggerHoldAction("drag");
    win.startDragging();
  }
});

canvas.addEventListener("mouseup", (e) => {
  if (e.button !== 0) return;
  endHoldAction();
  mouseDown = null;
});

canvas.addEventListener("mouseleave", () => {
  // 鼠标离开也结束（避免卡住）
  endHoldAction();
  mouseDown = null;
});

// ===== 右键菜单（Shift+右键 = 调试菜单）=====
canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  invoke("show_context_menu", { debug: e.shiftKey }).catch((err) => console.error("menu", err));
});

// ===== 渲染主循环 =====
// ===== 拖动结束检测（由 Rust 侧 Moved debounce emit）=====
// 左键拖=移位，只存位置不掉落（掉落走右键菜单）
listen("drag-ended", () => {
  invoke("save_window_pos").catch(() => {});
});

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
      ctx.rotate(currentPayload.rotation);
    }
    // 64×64 帧放大到 96×96 居中显示（1.5x，保持像素感）
    ctx.drawImage(imgToDraw, -48, -48, 96, 96);
    ctx.restore();
  } else {
    // 帧未加载完，画占位
    ctx.fillStyle = "#6b7280";
    ctx.fillRect(0, 0, 96, 96);
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
  Working: [
    "需求好急", "这个 bug 改不完", "再撑一下", "今天也得加班",
    "需求又变了", "代码跑起来了…先别问怎么跑的", "再来一杯咖啡",
    "这行代码我昨天写的？", "测试环境又挂了", "差一个分号",
  ],
  Tired: [
    "眼皮好沉", "撑不住了", "几点了", "让我趴五分钟",
    "眼睛要瞎了", "腰已经不是我的了", "再撑一个 PR…", "咖啡因耗尽了",
  ],
  Exhausted: [
    "我废了", "需要躺一会", "别叫我了", "已失去战斗能力",
    "给我一张床", "再见职场", "尸体已凉", "下班即天堂",
  ],
  Overworked: [
    "不行了", "救护车…", "到极限了", "心脏不太对劲",
    "工位就是我的坟墓", "我已经30小时没合眼了", "需要抢救", "写得我想吐",
  ],
  Idle: [
    "带薪摸鱼", "老板没在看", "我瘫一会儿", "假装在思考",
    "其实是发呆", "摸鱼是生产力的副产品", "再刷五分钟", "今天不想努力了",
  ],
  NightShift: [
    "zzZ", "夜班双倍，值了", "天怎么亮了", "凌晨三点还在 push",
    "我的肝啊", "独守空工位", "外卖小哥都睡了", "凌晨的键盘声真好听",
  ],
  Excited: [
    "冲冲冲", "需求好急！", "今天状态不错", "灵感来了",
    "我能再写五百年", "状态拉满", "产品经理说得对！", "这个 bug 我能修",
  ],
  Focused: [
    "别打扰我", "进入心流了", "嘘…在想问题", "这段逻辑终于通了",
    "别打断我", "沉浸中", "我好像懂了", "再给我十分钟",
  ],
  Chaotic: [
    "甲方又改需求", "我在切哪个窗口", "信息过载", "git 冲突了救命",
    "谁的锅", "时间线全乱了", "十个会议等我开", "需求文档自相矛盾",
  ],
  Happy: [
    "交付了！", "终于能睡了", "下班！", "这个 bug 修好了",
    "奖金到账美滋滋", "老板夸我了", "今天不用加班！", "上线无事故",
  ],
};
const BUBBLE_WEIGHT = {
  Exhausted: 0.8,
  Overworked: 0.8,
  Happy: 0.85,
  Tired: 0.5,
  NightShift: 0.5,
  Excited: 0.5,
  Working: 0.4,
  Idle: 0.4,
  Focused: 0.35,
  Chaotic: 0.6,
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

// 右键菜单「掉下去」→ 触发掉落物理
listen("menu/fall", () => {
  startFallIfNeeded();
});

// 换皮肤（右键菜单触发）
listen("skin-switched", async (event) => {
  const skinName = event.payload;
  await loadSkin(skinName);
  stateFrame = 0;
});

// 动作预览（右键菜单"动作预览"手动触发）
const STATE_ACTIONS = ["idle", "working", "tired", "exhausted", "overworked", "nightshift", "happy", "promoted", "lunchnap", "vacation"];
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

// 特殊事件：番茄钟完成 → Happy 庆祝
listen("pomodoro-complete", () => {
  endHoldAction();
  triggerOneShot("happy");
});
// 进医院 → 强制 exhausted
listen("hospital-admit", () => {
  endHoldAction();
  currentState = "exhausted";
  stateFrame = 0;
  previewUntil = performance.now() + 300000; // 冻结5分钟（医院期间不被动覆盖）
});
// 出院 → 回正常状态
listen("hospital-discharge", () => {
  previewUntil = 0; // 解除冻结，恢复真实感知驱动
});

// ===== Phase 3 特殊事件 =====
// 午休 → 切 lunchnap 状态（持续到时段结束/开始打字）
listen("lunch-nap", () => {
  endHoldAction();
  currentState = "lunchnap";
  stateFrame = 0;
  previewUntil = performance.now() + 600000; // 冻结10分钟（午休期间）
});
// 发工资 → 播 payday 动作
listen("payday", () => {
  endHoldAction();
  triggerOneShot("payday");
});
// 团建 → 播 teambuilding 动作
listen("team-building", () => {
  endHoldAction();
  triggerOneShot("teambuilding");
});
// 升职 → 播 promoted 庆祝动画后回正常（升职是永久的，但不需要一直摆pose）
listen("promoted", () => {
  endHoldAction();
  triggerOneShot("promoted");
});
// 度假 → 切 vacation 状态
listen("vacation-start", () => {
  endHoldAction();
  currentState = "vacation";
  stateFrame = 0;
  // 度假持续几天，previewUntil 设很长
  previewUntil = performance.now() + 3 * 86400000;
});
// 度假结束 → 回正常
listen("vacation-end", () => {
  previewUntil = 0;
});
// 离职 → 播 leave 动作
listen("leave-event", () => {
  endHoldAction();
  triggerOneShot("leave");
  previewUntil = performance.now() + 3 * 86400000; // 离职3天
});
// 回归 → 播 return 动作
listen("return-from-leave", () => {
  previewUntil = 0;
  triggerOneShot("return");
});

// 数值细条更新（红线2 调整后：四属性对前端可见）
const barStamina = document.getElementById("bar-stamina");
const barMood = document.getElementById("bar-mood");
const numSavings = document.getElementById("num-savings");
const numWage = document.getElementById("num-wage");
const floatGain = document.getElementById("float-gain");
let lastSavings = 0;
let gainTimer = null;

listen("stats-update", (event) => {
  const s = event.payload;
  if (barStamina) {
    barStamina.style.width = `${Math.max(0, Math.min(100, s.stamina))}%`;
    barStamina.classList.toggle("low", s.stamina < 30);
  }
  if (barMood) {
    barMood.style.width = `${Math.max(0, Math.min(100, s.mood))}%`;
    barMood.classList.toggle("low", s.mood < 30);
  }
  if (numWage) numWage.textContent = s.hourly_wage.toFixed(0);

  // 存款增加特效：检测增量，飘 "+N"
  const newSavings = Math.floor(s.savings);
  if (numSavings) numSavings.textContent = newSavings;
  const gain = newSavings - lastSavings;
  if (gain > 0 && floatGain) {
    floatGain.textContent = `+${gain}`;
    floatGain.classList.remove("show");
    void floatGain.offsetWidth; // 触发重绘，重启动画
    floatGain.classList.add("show");
    // 存款数字金色高亮
    numSavings.classList.add("gain");
    clearTimeout(gainTimer);
    gainTimer = setTimeout(() => numSavings.classList.remove("gain"), 600);
  }
  lastSavings = newSavings;
});

// ===== 启动（顶层 await，target=esnext 支持） =====
await loadSkin("default");
requestAnimationFrame(render);
