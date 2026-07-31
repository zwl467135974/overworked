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
let mountCache = {}; // { "sword": Image, "dragon": Image, ... } 坐骑造型图（皮肤提供）
let spellCache = {}; // { "fireball": Image, "ice": Image, ... } 法术图标（皮肤提供）

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
  mountCache = {};
  spellCache = {};

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
  // 加载坐骑造型图（mounts/sword.png 等）
  for (const m of (info.mounts || [])) {
    tasks.push(
      invoke("read_skin_asset", { skin: info.name, category: "mounts", name: m }).then((dataUrl) => {
        if (dataUrl) {
          const img = new Image();
          img.onload = () => { mountCache[m] = img; };
          img.src = dataUrl;
        }
      })
    );
  }
  // 加载法术图标（spells/fireball.png 等）
  for (const s of (info.spells || [])) {
    tasks.push(
      invoke("read_skin_asset", { skin: info.name, category: "spells", name: s }).then((dataUrl) => {
        if (dataUrl) {
          const img = new Image();
          img.onload = () => { spellCache[s] = img; };
          img.src = dataUrl;
        }
      })
    );
  }
  await Promise.all(tasks);
  console.log(`[skin] 加载皮肤 ${info.name}：${Object.keys(info.actions).length} 动作, ${(info.mounts||[]).length} 坐骑图, ${(info.spells||[]).length} 法术图`);
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
  const winW_phys = WIN_W * scaleFactor;
  // 初始位置边界校验：超出则钳到屏幕内
  let x = Math.max(0, Math.min(startX, screenW - winW_phys));
  // 智能选方向：靠右走左，靠左走右，中间随机
  let dir;
  if (startX > screenW - winW_phys - 100) {
    dir = -1; // 靠右了，往左走
  } else if (startX < 100) {
    dir = 1; // 靠左了，往右走
  } else {
    dir = Math.random() < 0.5 ? 1 : -1;
  }
  const distance = Math.round((80 + Math.random() * 120) * scaleFactor);
  let traveled = 0;

  walkDir = dir;
  triggerHoldAction("walk");

  let bounces = 0;
  const maxBounces = 2; // 撞墙最多回弹2次

  physicsTimer = setInterval(async () => {
    const step = Math.round(3 * scaleFactor);
    x += dir * step;
    traveled += step;
    // 撞墙回弹：到左/右边界反向继续走
    if (x < 0) {
      x = 0;
      dir = 1;
      walkDir = 1;
      bounces++;
    } else if (x > screenW - winW_phys) {
      x = screenW - winW_phys;
      dir = -1;
      walkDir = -1;
      bounces++;
    }
    // 走够距离或撞墙次数到了就停
    if (traveled > distance || bounces > maxBounces) {
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
// 左键拖=移位（存位置），位置在屏幕外则拉回
listen("drag-ended", async () => {
  invoke("save_window_pos").catch(() => {});
  // 边界校验：拖到屏幕外则拉回
  const monitor = await window.__TAURI__.window.currentMonitor().catch(() => null);
  if (!monitor) return;
  const sw = monitor.size.width;
  const sh = monitor.size.height;
  const sf = monitor.scaleFactor;
  let pos;
  try { pos = await win.outerPosition(); } catch { return; }
  const winW = WIN_W * sf;
  const winH = WIN_H * sf;
  let needFix = false;
  let nx = pos.x, ny = pos.y;
  if (pos.x < -winW * 0.5) { nx = 0; needFix = true; }
  if (pos.x > sw - winW * 0.3) { nx = sw - winW - 20; needFix = true; }
  if (pos.y < -winH * 0.5) { ny = 0; needFix = true; }
  if (pos.y > sh - 30) { ny = sh - winH - 20; needFix = true; }
  if (needFix) {
    const { PhysicalPosition } = window.__TAURI__.window;
    await win.setPosition(new PhysicalPosition(Math.round(nx), Math.round(ny)));
    invoke("save_window_pos").catch(() => {});
  }
});

// ===== 修仙坐骑（图优先，程序后备） =====
// 调用时 ctx 已 translate 到桌宠中心（原点 0,0），正 Y 向下。
// 在 drawImage(本体) 之前调用 = 坐骑在桌宠身后/下方。
// 有皮肤图 → drawImage + 程序动画层（浮动/发光/拖尾）
// 无皮肤图 → fallback 到程序绘制（飞剑/葫芦/龙等完整代码）
function drawMount(now) {
  if (!cultMode || currentMount < 1) return;
  const t = now / 1000;
  const mountKeys = ["", "sword", "gourd", "dragon", "qilin", "phoenix"];
  const key = mountKeys[currentMount];
  const skinImg = key ? mountCache[key] : null;

  ctx.globalCompositeOperation = "lighter";
  if (skinImg && skinImg.complete && skinImg.naturalWidth > 0) {
    // ===== 皮肤图优先：画静态坐骑 + 程序动画层 =====
    drawMountFromImage(skinImg, currentMount, t);
  } else {
    // ===== fallback：程序绘制 =====
    switch (currentMount) {
      case 1: drawMountSword(t); break;
      case 2: drawMountGourd(t); break;
      case 3: drawMountDragon(t); break;
      case 4: drawMountQilin(t); break;
      case 5: drawMountPhoenix(t); break;
    }
  }
  ctx.globalCompositeOperation = "source-over";
}

// 皮肤坐骑图绘制：静态图居中底部 + 程序叠加动画（浮动/发光/拖尾）
function drawMountFromImage(img, mountId, t) {
  const y = 38;
  const float = Math.sin(t * 1.5) * 1.5;
  // 按图片等比缩放到宽 64（坐骑图比角色宽），居中底部
  const iw = img.naturalWidth || 64;
  const ih = img.naturalHeight || 32;
  const dw = 64;
  const dh = ih * (dw / iw);
  // 底部发光层（所有坐骑通用：脚下灵光）
  const glow = ctx.createRadialGradient(0, y + 6, 0, 0, y + 6, 30);
  glow.addColorStop(0, "rgba(255,230,150,0.25)");
  glow.addColorStop(1, "rgba(255,200,100,0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.ellipse(0, y + 6, 30, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  // 坐骑图（source-over 保证图片原色，不走加法混合）
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(img, -dw / 2, y - dh / 2 + 4 + float, dw, dh);
  ctx.globalCompositeOperation = "lighter";
  // 顶部高光叠加（轻微发光感）
  const top = ctx.createRadialGradient(0, y - 4 + float, 0, 0, y - 4 + float, dw / 2);
  top.addColorStop(0, "rgba(255,255,200,0.15)");
  top.addColorStop(1, "rgba(255,255,200,0)");
  ctx.fillStyle = top;
  ctx.beginPath();
  ctx.ellipse(0, y - 4 + float, dw / 2, dh / 3, 0, 0, Math.PI * 2);
  ctx.fill();
  // 灵气粒子（2颗上飘）
  for (let i = 0; i < 2; i++) {
    const px = (Math.random() - 0.5) * 30;
    const py = y + 2 + float + Math.sin(t * 2 + i) * 3;
    ctx.fillStyle = "rgba(255,230,150,0.3)";
    ctx.beginPath();
    ctx.arc(px, py, 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

// 1. 飞剑：银白剑身横置脚下 + 灵光拖尾
function drawMountSword(t) {
  const y = 38;
  // 灵光拖尾（左右渐隐光带）
  const trail = ctx.createLinearGradient(-40, y, 40, y);
  trail.addColorStop(0, "rgba(150,200,255,0)");
  trail.addColorStop(0.5, "rgba(180,220,255,0.4)");
  trail.addColorStop(1, "rgba(150,200,255,0)");
  ctx.fillStyle = trail;
  ctx.fillRect(-40, y - 2, 80, 4);
  // 剑身（银白长条 + 微微浮动）
  const float = Math.sin(t * 2) * 1;
  ctx.fillStyle = "rgba(200,230,255,0.85)";
  ctx.fillRect(-28, y - 3 + float, 56, 6);
  // 剑柄
  ctx.fillStyle = "rgba(255,220,150,0.7)";
  ctx.fillRect(-32, y - 2 + float, 8, 4);
  // 剑尖高光
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.fillRect(24, y - 2 + float, 6, 2);
  // 脚下灵气粒子
  for (let i = 0; i < 3; i++) {
    const px = -20 + i * 20 + Math.sin(t * 3 + i) * 5;
    const py = y + 4 + Math.sin(t * 4 + i) * 2;
    ctx.fillStyle = "rgba(180,220,255,0.5)";
    ctx.beginPath();
    ctx.arc(px, py, 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

// 2. 葫芦：横版侧躺（经典骑葫芦造型），桌宠坐在葫芦肚子上
function drawMountGourd(t) {
  const y = 40;
  const float = Math.sin(t * 1.5) * 1.5;
  // ===== 灵气缭绕（底部雾气，两侧飘） =====
  for (let i = 0; i < 6; i++) {
    const px = -36 + i * 14 + Math.sin(t * 1.2 + i) * 4;
    const py = y + 8 + Math.sin(t * 1.5 + i) * 3;
    const g = ctx.createRadialGradient(px, py, 0, px, py, 10);
    g.addColorStop(0, "rgba(220,200,140,0.25)");
    g.addColorStop(1, "rgba(200,180,120,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, 10, 0, Math.PI * 2);
    ctx.fill();
  }
  // ===== 葫芦主体（横躺，左小右大） =====
  // 大肚（右侧主球，桌宠坐在这上面）
  const bigX = 6;
  const g1 = ctx.createRadialGradient(bigX - 4, y - 4 + float, 2, bigX, y + float, 22);
  g1.addColorStop(0, "rgba(255,245,160,0.95)");
  g1.addColorStop(0.4, "rgba(255,220,80,0.85)");
  g1.addColorStop(0.8, "rgba(200,160,40,0.6)");
  g1.addColorStop(1, "rgba(160,120,20,0)");
  ctx.fillStyle = g1;
  ctx.beginPath();
  ctx.ellipse(bigX, y + float, 22, 16, 0, 0, Math.PI * 2);
  ctx.fill();
  // 小肚（左侧上球）
  const smallX = -16;
  const g2 = ctx.createRadialGradient(smallX - 2, y - 6 + float, 0, smallX, y - 2 + float, 14);
  g2.addColorStop(0, "rgba(255,240,150,0.9)");
  g2.addColorStop(0.6, "rgba(220,180,50,0.7)");
  g2.addColorStop(1, "rgba(180,140,30,0)");
  ctx.fillStyle = g2;
  ctx.beginPath();
  ctx.ellipse(smallX, y - 2 + float, 14, 11, 0, 0, Math.PI * 2);
  ctx.fill();
  // 葫芦腰（连接处收窄阴影）
  ctx.strokeStyle = "rgba(160,120,20,0.4)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-6, y - 8 + float);
  ctx.lineTo(-2, y + 4 + float);
  ctx.stroke();
  // 葫芦口（最左端，朝左翘起）
  ctx.fillStyle = "rgba(255,210,90,0.7)";
  ctx.beginPath();
  ctx.ellipse(-28, y - 6 + float, 4, 3, -0.3, 0, Math.PI * 2);
  ctx.fill();
  // 腰带（红绳缠绕葫芦腰）
  ctx.strokeStyle = "rgba(220,60,40,0.6)";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(-8, y - 10 + float);
  ctx.quadraticCurveTo(-4, y - 4 + float, -2, y + 2 + float);
  ctx.stroke();
  // 高光（葫芦肚子上的光泽）
  ctx.fillStyle = "rgba(255,255,220,0.35)";
  ctx.beginPath();
  ctx.ellipse(bigX - 6, y - 8 + float, 6, 3, -0.3, 0, Math.PI * 2);
  ctx.fill();
}

// 3. 青龙：龙身蜿蜒 + 龙头龙须龙鳞 + 龙爪
function drawMountDragon(t) {
  const y = 38;
  // ===== 龙身外层光晕（发光体） =====
  ctx.strokeStyle = "rgba(100,255,150,0.25)";
  ctx.lineWidth = 14;
  ctx.lineCap = "round";
  drawDragonBody(t, y);
  // ===== 龙身主体（青绿） =====
  ctx.strokeStyle = "rgba(60,200,100,0.6)";
  ctx.lineWidth = 9;
  drawDragonBody(t, y);
  // ===== 龙身高光（亮绿） =====
  ctx.strokeStyle = "rgba(160,255,180,0.4)";
  ctx.lineWidth = 4;
  drawDragonBody(t, y);
  // ===== 龙鳞（沿身体的点阵） =====
  ctx.fillStyle = "rgba(180,255,200,0.5)";
  for (let i = 1; i < 18; i += 2) {
    const px = -34 + i * 4;
    const py = y + Math.sin(i * 0.4 + t * 2) * 7;
    ctx.beginPath();
    ctx.arc(px, py - 3, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
  // ===== 龙头（右端，详细造型） =====
  const headX = 38;
  const headY = y + Math.sin(17 * 0.4 + t * 2) * 7;
  // 龙头光晕
  const hg = ctx.createRadialGradient(headX, headY, 0, headX, headY, 14);
  hg.addColorStop(0, "rgba(140,255,160,0.7)");
  hg.addColorStop(1, "rgba(60,200,100,0)");
  ctx.fillStyle = hg;
  ctx.beginPath();
  ctx.arc(headX, headY, 14, 0, Math.PI * 2);
  ctx.fill();
  // 龙头主体
  ctx.fillStyle = "rgba(80,220,120,0.7)";
  ctx.beginPath();
  ctx.ellipse(headX, headY, 9, 7, 0, 0, Math.PI * 2);
  ctx.fill();
  // 龙角（双角后掠）
  ctx.strokeStyle = "rgba(200,255,180,0.6)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(headX - 2, headY - 6);
  ctx.quadraticCurveTo(headX - 6, headY - 12, headX - 10, headY - 14);
  ctx.moveTo(headX + 2, headY - 5);
  ctx.quadraticCurveTo(headX, headY - 11, headX - 4, headY - 14);
  ctx.stroke();
  // 龙眼（发光金瞳）
  ctx.fillStyle = "rgba(255,240,100,0.95)";
  ctx.beginPath();
  ctx.arc(headX + 3, headY - 1, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.beginPath();
  ctx.arc(headX + 4, headY - 2, 1, 0, Math.PI * 2);
  ctx.fill();
  // 龙须（两根飘动的长须）
  ctx.strokeStyle = "rgba(180,255,200,0.5)";
  ctx.lineWidth = 1;
  for (const dy of [-2, 2]) {
    ctx.beginPath();
    ctx.moveTo(headX + 6, headY + dy);
    ctx.quadraticCurveTo(headX + 14, headY + dy + Math.sin(t * 3 + dy) * 3, headX + 20, headY + dy + 6 + Math.sin(t * 2 + dy) * 4);
    ctx.stroke();
  }
  // ===== 龙爪（下方两只爪，抓云） =====
  ctx.strokeStyle = "rgba(80,220,120,0.6)";
  ctx.lineWidth = 2;
  for (const cx of [-12, 12]) {
    const cy = y + 8;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx - 3, cy + 5);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy + 6);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + 3, cy + 5);
    ctx.stroke();
  }
  // ===== 云气（龙脚下） =====
  for (let i = 0; i < 3; i++) {
    const cx = -16 + i * 16;
    const cy = y + 12 + Math.sin(t + i) * 2;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 10);
    g.addColorStop(0, "rgba(180,220,255,0.2)");
    g.addColorStop(1, "rgba(180,220,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 10, 4, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

// 龙身曲线绘制（共用：外晕/主体/高光三层调用）
function drawDragonBody(t, y) {
  ctx.beginPath();
  for (let i = 0; i <= 18; i++) {
    const px = -34 + i * 4;
    const py = y + Math.sin(i * 0.4 + t * 2) * 7;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
}

// 4. 麒麟：金甲瑞兽（身体+鬃毛+双角+鳞甲+祥云蹄）
function drawMountQilin(t) {
  const y = 38;
  // ===== 祥云（四蹄踏云） =====
  for (let i = 0; i < 4; i++) {
    const cx = -24 + i * 16;
    const cy = y + 10 + Math.sin(t + i * 0.8) * 2;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 14);
    g.addColorStop(0, "rgba(255,230,160,0.35)");
    g.addColorStop(0.6, "rgba(255,210,100,0.15)");
    g.addColorStop(1, "rgba(255,200,100,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 14, 5, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // ===== 身体光晕 =====
  const aura = ctx.createRadialGradient(0, y, 0, 0, y, 28);
  aura.addColorStop(0, "rgba(255,220,100,0.2)");
  aura.addColorStop(1, "rgba(255,200,50,0)");
  ctx.fillStyle = aura;
  ctx.beginPath();
  ctx.ellipse(0, y, 28, 14, 0, 0, Math.PI * 2);
  ctx.fill();
  // ===== 身体（金色椭圆兽身） =====
  const bg = ctx.createRadialGradient(-4, y - 4, 2, 0, y, 24);
  bg.addColorStop(0, "rgba(255,245,160,0.85)");
  bg.addColorStop(0.5, "rgba(240,200,60,0.7)");
  bg.addColorStop(1, "rgba(180,140,30,0)");
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.ellipse(0, y, 24, 12, 0, 0, Math.PI * 2);
  ctx.fill();
  // ===== 鳞甲（身体上的菱形鳞片点阵） =====
  ctx.fillStyle = "rgba(255,250,180,0.3)";
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 6; col++) {
      const sx = -16 + col * 6 + (row % 2) * 3;
      const sy = y - 3 + row * 5;
      ctx.beginPath();
      ctx.arc(sx, sy, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // ===== 腿（四条，下方） =====
  ctx.strokeStyle = "rgba(220,180,50,0.6)";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  for (const lx of [-16, -8, 8, 16]) {
    ctx.beginPath();
    ctx.moveTo(lx, y + 6);
    ctx.lineTo(lx + (lx < 0 ? -1 : 1), y + 12);
    ctx.stroke();
  }
  // ===== 鬃毛（背部一排火焰状鬃毛） =====
  for (let i = 0; i < 5; i++) {
    const mx = -14 + i * 7;
    const my = y - 10;
    const g = ctx.createLinearGradient(mx, my, mx, my - 8);
    g.addColorStop(0, "rgba(255,200,80,0.6)");
    g.addColorStop(1, "rgba(255,120,0,0)");
    ctx.strokeStyle = g;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(mx, my);
    ctx.quadraticCurveTo(mx + 2, my - 5, mx, my - 9);
    ctx.stroke();
  }
  // ===== 头部（右前方，兽首） =====
  const hx = 20;
  const hy = y - 5;
  const hg = ctx.createRadialGradient(hx, hy, 0, hx, hy, 12);
  hg.addColorStop(0, "rgba(255,250,170,0.85)");
  hg.addColorStop(0.6, "rgba(240,200,60,0.6)");
  hg.addColorStop(1, "rgba(200,160,40,0)");
  ctx.fillStyle = hg;
  ctx.beginPath();
  ctx.ellipse(hx, hy, 10, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  // ===== 双角（分叉鹿角造型） =====
  ctx.strokeStyle = "rgba(255,240,180,0.7)";
  ctx.lineWidth = 1.5;
  // 左角
  ctx.beginPath();
  ctx.moveTo(hx - 2, hy - 6);
  ctx.lineTo(hx - 4, hy - 12);
  ctx.moveTo(hx - 4, hy - 9);
  ctx.lineTo(hx - 7, hy - 11);
  ctx.stroke();
  // 右角
  ctx.beginPath();
  ctx.moveTo(hx + 2, hy - 6);
  ctx.lineTo(hx + 4, hy - 13);
  ctx.moveTo(hx + 4, hy - 10);
  ctx.lineTo(hx + 7, hy - 12);
  ctx.stroke();
  // ===== 眼睛 =====
  ctx.fillStyle = "rgba(255,240,100,0.9)";
  ctx.beginPath();
  ctx.arc(hx + 4, hy - 1, 1.5, 0, Math.PI * 2);
  ctx.fill();
}

// 5. 凤凰：火凤（凤冠+长尾羽翎+展翅+凤目）
function drawMountPhoenix(t) {
  const y = 36;
  const wingFlap = Math.sin(t * 4) * 0.25;
  // ===== 翅膀（左右各展，多根分层羽毛） =====
  drawPhoenixWing(-3, y - 2, -1, wingFlap);
  drawPhoenixWing(3, y - 2, 1, wingFlap);
  // ===== 身体（火红椭圆 + 光晕） =====
  const aura = ctx.createRadialGradient(0, y, 0, 0, y, 20);
  aura.addColorStop(0, "rgba(255,200,80,0.25)");
  aura.addColorStop(1, "rgba(255,100,0,0)");
  ctx.fillStyle = aura;
  ctx.beginPath();
  ctx.arc(0, y, 20, 0, Math.PI * 2);
  ctx.fill();
  const bg = ctx.createRadialGradient(-2, y - 2, 1, 0, y, 14);
  bg.addColorStop(0, "rgba(255,230,120,0.9)");
  bg.addColorStop(0.5, "rgba(255,140,40,0.7)");
  bg.addColorStop(1, "rgba(200,60,0,0)");
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.ellipse(0, y, 13, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  // ===== 凤头（前方） + 凤冠 =====
  const hx = 10;
  const hy = y - 4;
  const hg = ctx.createRadialGradient(hx, hy, 0, hx, hy, 9);
  hg.addColorStop(0, "rgba(255,220,100,0.85)");
  hg.addColorStop(1, "rgba(255,120,20,0)");
  ctx.fillStyle = hg;
  ctx.beginPath();
  ctx.arc(hx, hy, 9, 0, Math.PI * 2);
  ctx.fill();
  // 凤冠（头顶三根冠羽，上翘）
  ctx.strokeStyle = "rgba(255,180,50,0.7)";
  ctx.lineWidth = 1.5;
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.moveTo(hx + i * 2, hy - 6);
    ctx.quadraticCurveTo(hx + i * 3, hy - 10, hx + i * 4, hy - 13);
    ctx.stroke();
  }
  // 凤目
  ctx.fillStyle = "rgba(255,255,200,0.9)";
  ctx.beginPath();
  ctx.arc(hx + 3, hy - 1, 1.5, 0, Math.PI * 2);
  ctx.fill();
  // ===== 长尾羽翎（后方，3根长翎+渐隐火焰） =====
  for (let i = 0; i < 3; i++) {
    const offset = (i - 1) * 4;
    const wave = Math.sin(t * 2.5 + i) * 3;
    // 主翎杆
    const g = ctx.createLinearGradient(-8, y, -40, y + offset + wave);
    g.addColorStop(0, "rgba(255,180,60,0.7)");
    g.addColorStop(0.5, "rgba(255,100,20,0.5)");
    g.addColorStop(1, "rgba(255,60,0,0)");
    ctx.strokeStyle = g;
    ctx.lineWidth = 3 - i * 0.5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-8, y + offset);
    ctx.quadraticCurveTo(-22, y + offset + wave * 0.5, -38, y + offset + wave);
    ctx.stroke();
    // 翎眼（尾羽末端的彩色眼斑）
    const tx = -36;
    const ty = y + offset + wave;
    const eg = ctx.createRadialGradient(tx, ty, 0, tx, ty, 4);
    eg.addColorStop(0, "rgba(180,80,255,0.6)");
    eg.addColorStop(0.5, "rgba(255,100,40,0.4)");
    eg.addColorStop(1, "rgba(255,60,0,0)");
    ctx.fillStyle = eg;
    ctx.beginPath();
    ctx.arc(tx, ty, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

// 凤凰翅膀（分层羽毛绘制）
function drawPhoenixWing(x, y, dir, flap) {
  // 5 根分层羽毛（从短到长，颜色从亮到暗）
  for (let i = 0; i < 5; i++) {
    const angle = dir * (0.2 + i * 0.2 + flap);
    const len = 10 + i * 4;
    const ex = x + Math.cos(angle - Math.PI / 2) * len * dir;
    const ey = y + Math.sin(angle - Math.PI / 2) * len;
    const g = ctx.createLinearGradient(x, y, ex, ey);
    g.addColorStop(0, "rgba(255,210,80,0.7)");
    g.addColorStop(0.6, "rgba(255,120,20,0.5)");
    g.addColorStop(1, "rgba(255,60,0,0)");
    ctx.strokeStyle = g;
    ctx.lineWidth = 4 - i * 0.4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  }
}

// ===== 修仙境界光环（程序化绘制，不依赖美术） =====
// 在桌宠本体绘制后叠加，跟随 translate/scale 变换。
// 调用时 ctx 已 translate 到桌宠中心（原点），绘制坐标以原点为参考。
// now 用于动画（金丹旋转/光环呼吸）。
// 注意：这里手动叠加光效，不依赖 ctx.filter（filter 已被表情层占用）。
function drawRealmAura(now) {
  if (!cultMode || cultRealm < 1) return;
  const t = now / 1000; // 秒

  // ===== 练气(1)+：青色灵气 —— 绕体旋转的气点 + 柔光晕 =====
  if (cultRealm >= 1) {
    ctx.globalCompositeOperation = "lighter";
    // 底层柔光晕（呼吸）
    const breath = 0.7 + Math.sin(t * 2) * 0.2;
    const r = 44;
    const g = ctx.createRadialGradient(0, 0, 8, 0, 0, r);
    g.addColorStop(0, `rgba(100, 230, 200, ${0.22 * breath})`);
    g.addColorStop(0.5, `rgba(60, 200, 170, ${0.1 * breath})`);
    g.addColorStop(1, "rgba(60, 200, 170, 0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    // 3 颗气点绕体旋转（明显可见的粒子）
    for (let i = 0; i < 3; i++) {
      const angle = t * 1.5 + (i * Math.PI * 2) / 3;
      const px = Math.cos(angle) * 30;
      const py = Math.sin(angle) * 30 - 2;
      const pg = ctx.createRadialGradient(px, py, 0, px, py, 6);
      pg.addColorStop(0, "rgba(150, 255, 220, 0.9)");
      pg.addColorStop(0.5, "rgba(80, 230, 190, 0.5)");
      pg.addColorStop(1, "rgba(80, 230, 190, 0)");
      ctx.fillStyle = pg;
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  // ===== 筑基(2)+：灵体化 —— 蓝白光体 + 漂浮灵魂碎片 =====
  if (cultRealm >= 2) {
    ctx.globalCompositeOperation = "lighter";
    // 蓝白光体罩（比练气更亮、偏蓝）
    const breath = 0.8 + Math.sin(t * 1.8) * 0.15;
    const g = ctx.createRadialGradient(0, 2, 5, 0, 2, 38);
    g.addColorStop(0, `rgba(180, 230, 255, ${0.2 * breath})`);
    g.addColorStop(0.5, `rgba(120, 200, 255, ${0.1 * breath})`);
    g.addColorStop(1, "rgba(120, 200, 255, 0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 2, 38, 0, Math.PI * 2);
    ctx.fill();
    // 4 片漂浮灵魂碎片（上下缓慢飘动的小光块）
    for (let i = 0; i < 4; i++) {
      const baseAngle = (i * Math.PI * 2) / 4 + t * 0.4;
      const dist = 26 + Math.sin(t * 1.2 + i) * 4;
      const px = Math.cos(baseAngle) * dist;
      const py = Math.sin(baseAngle) * dist * 0.7 - 4;
      ctx.fillStyle = `rgba(200, 240, 255, ${0.6 + Math.sin(t * 2 + i) * 0.2})`;
      ctx.beginPath();
      ctx.arc(px, py, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  // ===== 金丹(3)+：胸口金丹 —— 大金球 + 旋转轨道粒子 =====
  if (cultRealm >= 3) {
    ctx.globalCompositeOperation = "lighter";
    const danX = 0;
    const danY = 8; // 胸口
    // 金丹大光晕（脉冲）
    const pulse = 1 + Math.sin(t * 4) * 0.15;
    const gr = 16 * pulse;
    const g = ctx.createRadialGradient(danX, danY, 0, danX, danY, gr);
    g.addColorStop(0, "rgba(255, 240, 150, 1)");
    g.addColorStop(0.3, "rgba(255, 215, 0, 0.8)");
    g.addColorStop(0.7, "rgba(255, 160, 0, 0.3)");
    g.addColorStop(1, "rgba(255, 160, 0, 0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(danX, danY, gr, 0, Math.PI * 2);
    ctx.fill();
    // 金丹核心（实心亮黄球）
    ctx.fillStyle = "rgba(255, 250, 200, 0.95)";
    ctx.beginPath();
    ctx.arc(danX, danY, 4, 0, Math.PI * 2);
    ctx.fill();
    // 3 颗轨道粒子环绕金丹
    for (let i = 0; i < 3; i++) {
      const angle = t * 4 + (i * Math.PI * 2) / 3;
      const ox = Math.cos(angle) * 14;
      const oy = Math.sin(angle) * 14 * 0.6 + danY * 0.3;
      const og = ctx.createRadialGradient(danX + ox, danY + oy, 0, danX + ox, danY + oy, 5);
      og.addColorStop(0, "rgba(255, 240, 180, 0.8)");
      og.addColorStop(1, "rgba(255, 200, 0, 0)");
      ctx.fillStyle = og;
      ctx.beginPath();
      ctx.arc(danX + ox, danY + oy, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  // ===== 元婴(4)+：头顶双层光环 + 元婴小分身 =====
  if (cultRealm >= 4) {
    ctx.globalCompositeOperation = "lighter";
    const haloY = -34;
    const breath = 1 + Math.sin(t * 2.5) * 0.1;
    // 外层光环（大、亮、发光）
    ctx.strokeStyle = "rgba(255, 215, 0, 0.9)";
    ctx.lineWidth = 3;
    ctx.shadowColor = "#ffd700";
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.ellipse(0, haloY, 16 * breath, 6 * breath, 0, 0, Math.PI * 2);
    ctx.stroke();
    // 内层光环（小、更亮）
    ctx.strokeStyle = "rgba(255, 250, 200, 0.6)";
    ctx.lineWidth = 1.5;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.ellipse(0, haloY, 11 * breath, 4 * breath, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
    // 元婴小分身：头顶上方漂浮的迷你光人（一个发光小点 + 拖尾）
    const babyY = haloY - 8 + Math.sin(t * 3) * 2;
    const bg = ctx.createRadialGradient(0, babyY, 0, 0, babyY, 8);
    bg.addColorStop(0, "rgba(255, 255, 220, 0.9)");
    bg.addColorStop(0.5, "rgba(255, 230, 150, 0.4)");
    bg.addColorStop(1, "rgba(255, 230, 150, 0)");
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(0, babyY, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  }

  // ===== 化神(5)+：全身金光 + 环绕光粒 + 强悬浮 =====
  if (cultRealm >= 5) {
    ctx.globalCompositeOperation = "lighter";
    // 全身强金光晕（大范围、高亮度、呼吸）
    const breath = 0.85 + Math.sin(t * 1.5) * 0.15;
    const r = 52;
    const g = ctx.createRadialGradient(0, 0, 10, 0, 0, r);
    g.addColorStop(0, `rgba(255, 240, 150, ${0.35 * breath})`);
    g.addColorStop(0.4, `rgba(255, 210, 60, ${0.18 * breath})`);
    g.addColorStop(0.7, `rgba(255, 180, 0, ${0.08 * breath})`);
    g.addColorStop(1, "rgba(255, 180, 0, 0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    // 6 颗环绕光粒（椭圆轨道）
    for (let i = 0; i < 6; i++) {
      const angle = t * 1.2 + (i * Math.PI * 2) / 6;
      const px = Math.cos(angle) * 40;
      const py = Math.sin(angle) * 40 * 0.5; // 椭圆轨道
      const pg = ctx.createRadialGradient(px, py, 0, px, py, 7);
      pg.addColorStop(0, "rgba(255, 250, 200, 0.9)");
      pg.addColorStop(0.5, "rgba(255, 220, 80, 0.4)");
      pg.addColorStop(1, "rgba(255, 220, 80, 0)");
      ctx.fillStyle = pg;
      ctx.beginPath();
      ctx.arc(px, py, 7, 0, Math.PI * 2);
      ctx.fill();
    }
    // 底部光台（悬浮感：脚下有个发光圆台）
    const baseY = 40;
    const baseG = ctx.createRadialGradient(0, baseY, 0, 0, baseY, 24);
    baseG.addColorStop(0, "rgba(255, 230, 120, 0.4)");
    baseG.addColorStop(1, "rgba(255, 200, 50, 0)");
    ctx.fillStyle = baseG;
    ctx.beginPath();
    ctx.ellipse(0, baseY, 24, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  }
}

function render(now) {
  // 飞升结局：接管渲染（金光+上升+淡出）
  if (ascensionActive) {
    renderAscension(now);
    requestAnimationFrame(render);
    return;
  }

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
  // 化神(5)+ 或有坐骑：悬浮（脱离地面，缓慢上下浮动）
  if (cultMode && (cultRealm >= 5 || currentMount > 0)) {
    bounceDy += Math.sin(now / 600) * 3 - 4; // 基线抬高4px + 浮动±3
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
    // 坐骑：在本体之前画 = 在桌宠身后/下方
    drawMount(now);
    // 按图片实际尺寸等比缩放到高度96，居中显示（支持任意尺寸帧）
    const iw = imgToDraw.naturalWidth || 64;
    const ih = imgToDraw.naturalHeight || 64;
    const dh = 96;
    const dw = iw * (dh / ih);
    // 有坐骑时桌宠整体上移（坐在坐骑上）
    const mountLift = currentMount > 0 ? -6 : 0;
    ctx.drawImage(imgToDraw, -dw / 2, -dh / 2 + mountLift, dw, dh);
    // 修仙境界光环（叠加在本体上，跟随变换）
    drawRealmAura(now);
    ctx.restore();
  } else {
    // 帧未加载完，画占位
    ctx.fillStyle = "#6b7280";
    ctx.fillRect(0, 0, 96, 96);
  }

  ctx.filter = "none";
  ctx.globalAlpha = 1.0;

  // 粒子特效层（仅体力碎粒，其他特效交给 fx-overlay 全屏窗口）
  updateAndDrawParticles(now);

  requestAnimationFrame(render);
}

// ===== 粒子系统 =====
// 统一管理所有特效粒子：dot/symbol/line/ring/shard
let particles = [];

function spawnParticle(p) {
  if (particles.length > 30) return; // 上限防性能
  particles.push({ ...p, born: performance.now() });
}

// 打字→爆裂粒子（从角色中心向外辐射炸开）
function fxTypingDots(count) {
  const n = Math.min(8, 3 + Math.ceil(count));
  const color = currentState === "tired" ? "#9ca3af" : "#fbbf24";
  for (let i = 0; i < n; i++) {
    const angle = (Math.PI * 2 * i) / n + Math.random() * 0.5;
    const speed = 1.5 + Math.random() * 2;
    spawnParticle({
      type: "dot",
      x: 48,
      y: 45,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 1, // 略向上偏
      life: 500,
      color,
      size: 2 + Math.floor(Math.random() * 2),
      gravity: 0.08,
    });
  }
}

// 打字→代码符号爆炸（从中心炸出，加大字号）
const CODE_SYMBOLS = [";", "{", "}", "=>", "</>", "#", "()", "[]", "&&", "++"];
function fxCodeSymbols(count) {
  if (count < 3) return;
  const n = Math.min(3, Math.ceil(count / 2));
  for (let i = 0; i < n; i++) {
    const sym = CODE_SYMBOLS[Math.floor(Math.random() * CODE_SYMBOLS.length)];
    const angle = Math.random() * Math.PI * 2;
    const speed = 1 + Math.random() * 1.5;
    spawnParticle({
      type: "symbol",
      text: sym,
      x: 48,
      y: 45,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 0.5,
      life: 700,
      color: "#60a5fa",
      gravity: 0.06,
    });
  }
}

// 快速打字→冲击波（从中心扩散的大圆环 + 速度线）
function fxSpeedLines(count) {
  if (count < 5) return;
  // 冲击波圆环
  spawnParticle({
    type: "ring",
    x: 48,
    y: 48,
    radius: 6,
    vrad: 1.5,
    life: 350,
    color: "#fbbf24",
    lineWidth: 2,
  });
  // 速度线
  for (let i = 0; i < 4; i++) {
    const dir = Math.random() < 0.5 ? -1 : 1;
    spawnParticle({
      type: "line",
      x: 48,
      y: 30 + Math.random() * 30,
      vx: dir * (3 + Math.random() * 2),
      vy: 0,
      life: 250,
      color: "#fbbf24",
      len: 10,
    });
  }
}

// 点击→波纹
function fxClickRipple() {
  spawnParticle({
    type: "ring",
    x: 48,
    y: 48,
    radius: 4,
    life: 400,
    color: "#22d3ee",
  });
}

// 体力消耗→碎粒
function fxStaminaShard() {
  for (let i = 0; i < 2; i++) {
    spawnParticle({
      type: "shard",
      x: 60 + Math.random() * 10,
      y: 8,
      vx: (Math.random() - 0.5) * 2,
      vy: 1 + Math.random(),
      life: 500,
      color: "#ef4444",
      size: 2,
    });
  }
}

function updateAndDrawParticles(now) {
  if (particles.length === 0) return;
  const alive = [];

  // 加法混合（发光叠加）
  const prevComp = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = "lighter";

  for (const p of particles) {
    const age = now - p.born;
    if (age >= p.life) continue;
    const t = age / p.life;
    const alpha = (1 - t) * (1 - t); // 平方衰减

    if (p.vx !== undefined) p.x += p.vx;
    if (p.vy !== undefined) { p.y += p.vy; if (p.gravity) p.vy += p.gravity; }
    if (p.type === "ring") p.radius += p.vrad || 1;

    // 出生脉冲（前 60ms 弹出）
    let scale = 1;
    if (age < 60) { scale = age / 60; scale = 1 - (1 - scale) * (1 - scale); }

    ctx.globalAlpha = alpha * scale;

    if (p.type === "dot") {
      // 发光球：径向渐变
      const r = p.size * 2.5 * scale;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      g.addColorStop(0, p.color);
      g.addColorStop(0.4, p.color);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    } else if (p.type === "ring") {
      ctx.strokeStyle = p.color;
      ctx.lineWidth = (p.lineWidth || 3) * (1 - t * 0.7) * scale;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 12 * (1 - t);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
    } else if (p.type === "line") {
      ctx.fillStyle = p.color;
      ctx.fillRect(Math.round(p.x), Math.round(p.y), p.len * scale, 2);
    } else if (p.type === "shard") {
      ctx.fillStyle = p.color;
      ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
    }
    alive.push(p);
  }

  // 代码符号单独渲染（source-over + glow，不走 lighter）
  ctx.globalCompositeOperation = "source-over";
  for (const p of alive) {
    if (p.type !== "symbol") continue;
    const age = now - p.born;
    if (age >= p.life) continue;
    const t = age / p.life;
    ctx.globalAlpha = (1 - t) * (1 - t);
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 8;
    ctx.fillStyle = p.color;
    ctx.font = "bold 12px monospace";
    ctx.fillText(p.text, Math.round(p.x), Math.round(p.y));
  }
  ctx.shadowBlur = 0;

  particles = alive.filter((p) => (now - p.born) < p.life);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = prevComp;
}

// ===== 监听脉冲事件 =====
// typing/click 特效交给 fx-overlay 全屏窗口处理，main.js 不重复生成
// （避免双倍粒子导致性能问题）
listen("typing-pulse", () => {});

listen("click-pulse", () => {});

// 特效开关
let fxEnabled = true;
listen("fx-toggled", (event) => {
  fxEnabled = event.payload;
  if (!fxEnabled) particles = []; // 关闭时清空粒子
});

// ===== 趣味玩法 =====
// Boss来了 → 惊恐弹起（poke 动作 + 额外震动）
listen("boss-incoming", () => {
  endHoldAction();
  triggerOneShot("poke");
  // 全屏震动特效（在 fx-overlay 画）
});
// 投喂咖啡 → poke 动作（喝咖啡反应）
listen("coffee-boost", () => {
  endHoldAction();
  triggerOneShot("poke");
});

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
// 用 lerp 平滑过渡：5秒tick给目标值，每帧插值靠近，视觉实时扣血
const barStamina = document.getElementById("bar-stamina");
const barMood = document.getElementById("bar-mood");
const numSavings = document.getElementById("num-savings");
const numWage = document.getElementById("num-wage");
const floatGain = document.getElementById("float-gain");
let lastSavings = 0;
let lastStamina = 100;
let gainTimer = null;

// 平滑显示值（每帧 lerp 靠近目标值）
let displayStamina = 80;
let displayMood = 70;
let targetStamina = 80;
let targetMood = 70;

listen("stats-update", (event) => {
  const s = event.payload;
  targetStamina = Math.max(0, Math.min(100, s.stamina));
  targetMood = Math.max(0, Math.min(100, s.mood));
  if (numWage) numWage.textContent = s.hourly_wage.toFixed(0);

  // 存款增加特效
  const newSavings = Math.floor(s.savings);
  if (numSavings) numSavings.textContent = newSavings;
  const gain = newSavings - lastSavings;
  // 体力消耗特效
  if (s.stamina < lastStamina - 0.5) {
    fxStaminaShard();
    if (barStamina) {
      barStamina.classList.add("draining");
      setTimeout(() => barStamina.classList.remove("draining"), 300);
    }
  }
  lastStamina = s.stamina;
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

// 每帧 lerp 平滑更新血条（视觉实时扣血/回血）
function updateSmoothBars() {
  // lerp 因子 0.08：约 1 秒内追上目标值，看起来连续
  displayStamina += (targetStamina - displayStamina) * 0.08;
  displayMood += (targetMood - displayMood) * 0.08;
  if (barStamina) {
    barStamina.style.width = `${displayStamina}%`;
    barStamina.classList.toggle("low", displayStamina < 30);
  }
  if (barMood) {
    barMood.style.width = `${displayMood}%`;
    barMood.classList.toggle("low", displayMood < 30);
  }
  requestAnimationFrame(updateSmoothBars);
}
requestAnimationFrame(updateSmoothBars);

// ===== 修仙模式（红线放开：境界/修为可见） =====
const cultPanel = document.getElementById("cult-panel");
const cultRealmEl = document.getElementById("cult-realm");
const barExp = document.getElementById("bar-exp");
const statsPanel = document.getElementById("stats-panel");
let cultMode = false;
let cultRealm = 0; // 当前境界 0-6（render 循环读取，画光环/金丹等）
let currentMount = 0; // 当前装备坐骑 0=无, 1-5
const REALM_NAMES = ["凡人", "练气", "筑基", "金丹", "元婴", "化神", "飞升"];

// 坐骑装备/卸下事件
listen("mount-equipped", (event) => {
  currentMount = event.payload || 0;
});

// 修仙面板更新（tick 推送 + 商店购买后推送）
listen("cultivation-update", (event) => {
  const c = event.payload;
  if (c.cultivation_mode && !cultMode) {
    // 刚进入修仙模式：切换面板
    cultMode = true;
    statsPanel.hidden = true;
    cultPanel.hidden = false;
  } else if (!c.cultivation_mode && cultMode) {
    // 切回普通模式
    cultMode = false;
    statsPanel.hidden = false;
    cultPanel.hidden = true;
  }
  cultRealm = c.realm || 0;
  if (cultMode) {
    if (cultRealmEl) cultRealmEl.textContent = REALM_NAMES[c.realm] || "凡人";
    if (barExp) barExp.style.width = `${Math.max(0, Math.min(100, c.exp))}%`;
  }
});

// 开启修仙 → 庆祝动作
listen("cultivation-on", () => {
  endHoldAction();
  triggerOneShot("promoted"); // 复用升职庆祝动画
});
// 切回普通
listen("cultivation-off", () => {
  previewUntil = 0;
});
// 突破成功 → 金光 + 庆祝
listen("realm-up", (event) => {
  endHoldAction();
  triggerOneShot("promoted");
  if (cultRealmEl) {
    cultRealmEl.classList.remove("up");
    void cultRealmEl.offsetWidth;
    cultRealmEl.classList.add("up");
  }
});
// 走火入魔 → 颤抖
listen("cult-deviation", () => {
  if (cultPanel) {
    cultPanel.classList.remove("deviation");
    void cultPanel.offsetWidth;
    cultPanel.classList.add("deviation");
  }
});
// 续命丹救命 → poke 反应（缓过一口气）
listen("life-saved", () => {
  endHoldAction();
  triggerOneShot("poke");
});
// 飞升结局 → 桌宠本体发光上升淡出 + 通关字幕
listen("cult-ascension", () => {
  startAscensionEnding();
});

// 调试：复活（飞升后恢复桌宠，跳出结局动画）
listen("debug-revive", () => {
  ascensionActive = false;
  ascensionStart = 0;
  previewUntil = 0;
  // 移除飞升字幕（如果还在）
  const overlay = document.getElementById("ascension-overlay");
  if (overlay) overlay.remove();
  // 恢复窗口显示
  win.show().catch(() => {});
  // 恢复正常渲染（render 循环会自动接管，因为 ascensionActive=false）
});

// ===== 飞升结局动画 =====
// 桌宠本体：金光叠加 → 向上漂浮 → 淡出消失 → 通关字幕
let ascensionActive = false;
let ascensionStart = 0;

function startAscensionEnding() {
  if (ascensionActive) return;
  ascensionActive = true;
  ascensionStart = 0;
  // 冻结状态机，停止随机动作
  previewUntil = performance.now() + 999999999;
  endHoldAction();
  oneShotAction = null;

  // 通关字幕 DOM（覆盖在桌宠窗口上）
  const overlay = document.createElement("div");
  overlay.id = "ascension-overlay";
  overlay.innerHTML = '<div class="asc-text">飞 升</div><div class="asc-sub">它终得道，化光而去</div>';
  document.body.appendChild(overlay);
  // 触发重绘后显示
  requestAnimationFrame(() => overlay.classList.add("show"));

  // 6 秒后移除字幕（桌宠已隐，留个纪念）
  setTimeout(() => {
    overlay.classList.remove("show");
    setTimeout(() => overlay.remove(), 1000);
  }, 6000);
}

// 飞升渲染（由 render 主循环在 ascensionActive 时调用）
function renderAscension(now) {
  if (!ascensionStart) ascensionStart = now;
  const elapsed = now - ascensionStart;
  const PHASE_GLOW = 1500;   // 0-1.5s：金光渐强
  const PHASE_FLOAT = 4000;  // 1.5-4s：上升淡出
  const PHASE_DONE = 4200;   // 4.2s：完全消失

  ctx.clearRect(0, 0, 96, 96);

  let opacity = 1;
  let brightness = 1;
  let liftY = 0;
  if (elapsed < PHASE_GLOW) {
    const t = elapsed / PHASE_GLOW;
    brightness = 1 + t * 2.5; // 1→3.5
  } else if (elapsed < PHASE_FLOAT) {
    const t = (elapsed - PHASE_GLOW) / (PHASE_FLOAT - PHASE_GLOW);
    brightness = 3.5;
    opacity = 1 - t; // 淡出
    liftY = -t * 60;  // 向上飘 60px
  } else {
    opacity = 0;
  }

  const frames = getFrames(currentState);
  const img = frames.length > 0 ? frames[stateFrame % frames.length] : null;
  if (img && img.complete && img.naturalWidth > 0) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, opacity);
    ctx.filter = `brightness(${brightness}) drop-shadow(0 0 ${8 + brightness * 4}px #ffd700)`;
    const iw = img.naturalWidth || 64;
    const ih = img.naturalHeight || 64;
    const dh = 96;
    const dw = iw * (dh / ih);
    ctx.translate(48, 48 + liftY);
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }
  // 推进帧（让动作继续播）
  if (now - lastFrameTime >= FRAME_INTERVAL) {
    lastFrameTime = now;
    stateFrame = (stateFrame + 1) % Math.max(1, frames.length);
  }

  if (elapsed >= PHASE_DONE) {
    // 完全消失：隐藏窗口（桌宠已飞升）
    ascensionActive = false;
    ascensionStart = 0;
    win.hide().catch(() => {});
  }
}

// ===== 启动（顶层 await，target=esnext 支持） =====
// 从存档恢复上次使用的皮肤（不存在则 default）
const savedSkin = await invoke("get_saved_skin").catch(() => "default");
await loadSkin(savedSkin);
requestAnimationFrame(render);
