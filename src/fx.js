// Overworked 全屏特效层（fx-overlay 窗口）
//
// 酷炫粒子系统：加法混合 + 发光球 + 冲击波 + screen shake。
// 打字→桌宠头顶爆裂（能量溢出）；点击→实际点击坐标爆发。
// 点击穿透，不影响下层操作。

const { listen } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;
const { invoke } = window.__TAURI__.core;
const win = getCurrentWindow();

const canvas = document.getElementById("fx-canvas");
const ctx = canvas.getContext("2d");

// ===== 法术图标缓存（当前皮肤的 spells/ 图） =====
let spellIcons = {}; // { "fireball": Image, ... }
let currentSkinName = "default";

async function loadSpellIcons() {
  spellIcons = {};
  try {
    const skins = await invoke("list_skins");
    const info = skins.find((s) => s.name === currentSkinName) || skins[0];
    if (!info || !info.spells) return;
    for (const s of info.spells) {
      const dataUrl = await invoke("read_skin_asset", { skin: info.name, category: "spells", name: s });
      if (dataUrl) {
        const img = new Image();
        img.onload = () => { spellIcons[s] = img; };
        img.src = dataUrl;
      }
    }
    console.log(`[fx] 加载 ${info.spells.length} 个法术图标`);
  } catch (e) {
    console.warn("[fx] 法术图标加载失败", e);
  }
}

// 皮肤切换时重新加载法术图标
listen("skin-switched", (event) => {
  currentSkinName = event.payload || "default";
  loadSpellIcons();
});
// 启动时加载一次
loadSpellIcons();

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resize();
window.addEventListener("resize", resize);

win.setIgnoreCursorEvents(true).catch(() => {});

// 桌宠位置（逻辑坐标），默认屏幕右下
let petX = window.innerWidth - 100;
let petY = window.innerHeight - 150;

listen("pet-position", (event) => {
  const p = event.payload;
  if (Array.isArray(p)) {
    petX = p[0];
    petY = p[1];
  }
});

// ===== 粒子系统 =====
let particles = [];
let symbols = []; // 代码符号单独渲染（不走 lighter）
let shakeAmp = 0;
let flashAlpha = 0;
const MAX_PARTICLES = 120; // 法术特效需要更多粒子

function spawnDot(x, y, vx, vy, color, size, life, gravity) {
  if (particles.length > MAX_PARTICLES) return;
  particles.push({ type: "dot", x, y, vx, vy, color, size: size || 3, life: life || 350, gravity: gravity || 0.1, born: performance.now() });
}
// 法术图标粒子（贴图绘制，旋转可选）。有图标用图标，无则 fallback 到 spawnDot。
function spawnSpellParticle(spell, x, y, vx, vy, size, life, gravity, rotation) {
  const img = spellIcons[spell];
  if (img && img.complete && img.naturalWidth > 0) {
    if (particles.length > MAX_PARTICLES) return;
    particles.push({ type: "icon", img, x, y, vx, vy, size: size || 16, life: life || 600, gravity: gravity || 0.05, rotation: rotation || 0, spin: (Math.random() - 0.5) * 0.2, born: performance.now() });
  } else {
    // fallback：通用发光球
    spawnDot(x, y, vx, vy, "#ffaa00", (size || 16) / 4, life, gravity);
  }
}
function spawnRing(x, y, color, vrad, life, lineWidth) {
  if (particles.length > MAX_PARTICLES) return;
  particles.push({ type: "ring", x, y, radius: 6, vrad: vrad || 2.5, color, life: life || 300, lineWidth: lineWidth || 4, born: performance.now() });
}
// 冲击波（厚环，带填充渐变，比 ring 更有质感）
function spawnShockwave(x, y, color, maxRadius, life) {
  if (particles.length > MAX_PARTICLES) return;
  particles.push({ type: "shockwave", x, y, radius: 4, maxRadius: maxRadius || 120, color, life: life || 600, born: performance.now() });
}
// 光束（矩形，带方向和宽度，用于光柱/激光）
function spawnBeam(x, y, angle, length, width, color, life) {
  if (particles.length > MAX_PARTICLES) return;
  particles.push({ type: "beam", x, y, angle, length, width, color, life: life || 500, born: performance.now() });
}
// 闪电分支（锯齿折线，从起点到终点，带随机分叉）
function spawnLightning(x1, y1, x2, y2, color, life, branches) {
  if (particles.length > MAX_PARTICLES) return;
  // 生成锯齿路径点
  const points = [];
  const steps = 10;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const px = x1 + (x2 - x1) * t + (Math.random() - 0.5) * 20 * (i > 0 && i < steps ? 1 : 0);
    const py = y1 + (y2 - y1) * t + (Math.random() - 0.5) * 20 * (i > 0 && i < steps ? 1 : 0);
    points.push({ x: px, y: py });
  }
  particles.push({ type: "lightning", points, color, life: life || 300, born: performance.now() });
  // 分叉
  if (branches) {
    for (let b = 0; b < branches; b++) {
      const branchStep = Math.floor(Math.random() * (steps - 2)) + 1;
      const sp = points[branchStep];
      const ep = { x: sp.x + (Math.random() - 0.5) * 60, y: sp.y + Math.random() * 40 + 10 };
      spawnLightning(sp.x, sp.y, ep.x, ep.y, color, life * 0.7, 0);
    }
  }
}
function spawnSymbol(text, x, y, vx, vy, color) {
  if (symbols.length > 8) return;
  symbols.push({ text, x, y, vx, vy, color, life: 700, gravity: 0.08, born: performance.now() });
}
// 光剑粒子（程序绘制的剑形：剑身+剑脊高光+剑格+剑首+剑尖星光）
// 有皮肤图标时用图标，否则程序绘制。
// angle: 剑身朝向（弧度），length: 剑身长度
function spawnFlyingSword(x, y, vx, vy, angle, length, color, life) {
  const img = spellIcons["swords"];
  if (img && img.complete && img.naturalWidth > 0) {
    // 皮肤图标优先
    if (particles.length > MAX_PARTICLES) return;
    particles.push({ type: "icon", img, x, y, vx, vy, size: length * 0.7, life: life || 700, gravity: 0, rotation: angle, spin: 0, born: performance.now() });
    return;
  }
  // 程序绘制光剑
  if (particles.length > MAX_PARTICLES) return;
  particles.push({ type: "sword", x, y, vx, vy, angle, length: length || 24, color: color || "#ffd700", life: life || 700, gravity: 0, born: performance.now() });
}
// 剑阵粒子（环形排列的悬浮剑，旋转收束）
let swordArrayParticles = []; // 单独管理剑阵（不走普通粒子循环）
function spawnSwordArray(cx, cy, count, radius, color) {
  swordArrayParticles = [];
  for (let i = 0; i < count; i++) {
    const baseAngle = (Math.PI * 2 * i) / count;
    swordArrayParticles.push({
      cx, cy, baseAngle, radius,
      color: color || "#ffd700",
      length: 22 + Math.random() * 6,
      born: performance.now(),
      life: 1500, // 剑阵持续时间
      phase: 0, // 0=展开旋转, 1=收束
    });
  }
}

const CODE_SYMBOLS = [";", "{", "}", "=>", "</>", "#", "()", "[]", "&&", "++", "fn", "let"];

// 打字→桌宠头顶爆裂
listen("typing-pulse", (event) => {
  const count = event.payload || 1;
  const cx = petX;
  const cy = petY - 40;

  // 主爆裂：发光球辐射（数量随强度）
  const n = Math.min(14, 5 + count);
  for (let i = 0; i < n; i++) {
    const angle = (Math.PI * 2 * i) / n + Math.random() * 0.5;
    const speed = 2.5 + Math.random() * 3.5;
    spawnDot(cx, cy, Math.cos(angle) * speed, Math.sin(angle) * speed - 1.5, "#fbbf24", 3 + Math.random() * 2, 450, 0.12);
  }

  // 快速打字（count>=4）：代码符号爆炸 + 冲击波
  if (count >= 4) {
    const sn = Math.min(4, Math.ceil(count / 2));
    for (let i = 0; i < sn; i++) {
      const sym = CODE_SYMBOLS[Math.floor(Math.random() * CODE_SYMBOLS.length)];
      const angle = Math.random() * Math.PI * 2;
      const speed = 2 + Math.random() * 2.5;
      spawnSymbol(sym, cx, cy, Math.cos(angle) * speed, Math.sin(angle) * speed - 1, "#60a5fa");
    }
    spawnRing(cx, cy, "#fbbf24", 3, 400, 5);
  }

  // 极速打字（count>=6）：screen shake + 白闪 + 二次冲击波
  if (count >= 6) {
    shakeAmp = Math.min(8, count * 0.8);
    flashAlpha = 0.12;
    spawnRing(cx, cy, "#ffffff", 4, 300, 3);
  }
});

// 点击→实际坐标爆发（rdev 发的可能是物理坐标，需缩放）
listen("click-pulse", (event) => {
  const p = event.payload;
  // rdev MouseMove 坐标是物理像素，fx-overlay 是全屏逻辑坐标
  // 直接用，因为 fx-overlay 窗口覆盖全屏
  const cx = p && p[0] !== undefined ? p[0] : petX;
  const cy = p && p[1] !== undefined ? p[1] : petY;
  // 限制在屏幕范围内
  const safeX = Math.max(0, Math.min(canvas.width, cx));
  const safeY = Math.max(0, Math.min(canvas.height, cy));
  spawnRing(safeX, safeY, "#22d3ee", 2.5, 400, 4);
  for (let i = 0; i < 5; i++) {
    const angle = (Math.PI * 2 * i) / 5;
    const speed = 2.5 + Math.random() * 2;
    spawnDot(cx, cy, Math.cos(angle) * speed, Math.sin(angle) * speed, "#22d3ee", 3, 400, 0.06);
  }
});

// ===== 修仙特效 =====
// 突破成功 → 金光爆裂（多层金环 + 金色粒子辐射 + screen shake + 白闪）
listen("realm-up", () => {
  const cx = petX;
  const cy = petY - 30;
  // 三层金色冲击波（递增半径，错峰扩散）
  spawnRing(cx, cy, "#ffd700", 3.5, 600, 6);
  setTimeout(() => spawnRing(cx, cy, "#ffe9a8", 4, 500, 5), 120);
  setTimeout(() => spawnRing(cx, cy, "#ffffff", 5, 400, 4), 240);
  // 金色粒子辐射（环形 16 颗 + 随机散射 10 颗）
  const ringN = 16;
  for (let i = 0; i < ringN; i++) {
    const angle = (Math.PI * 2 * i) / ringN;
    const speed = 4 + Math.random() * 2;
    spawnDot(cx, cy, Math.cos(angle) * speed, Math.sin(angle) * speed - 2, "#ffd700", 4, 700, 0.05);
  }
  for (let i = 0; i < 10; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 2 + Math.random() * 4;
    spawnDot(cx, cy, Math.cos(angle) * speed, Math.sin(angle) * speed - 1.5, "#ffe9a8", 3, 600, 0.08);
  }
  // 上升的灵气光点（从角色向上飘）
  for (let i = 0; i < 8; i++) {
    const ox = (Math.random() - 0.5) * 40;
    spawnDot(cx + ox, cy, (Math.random() - 0.5) * 0.5, -3 - Math.random() * 2, "#fff3c4", 3, 900, -0.02);
  }
  shakeAmp = 6;
  flashAlpha = 0.2;
});

// 走火入魔 → 红黑震荡（暗红冲击波 + 紫黑粒子 + 强烈 shake + 红闪）
listen("cult-deviation", () => {
  const cx = petX;
  const cy = petY - 30;
  // 暗红 + 紫黑双层冲击波
  spawnRing(cx, cy, "#dc2626", 3, 500, 6);
  setTimeout(() => spawnRing(cx, cy, "#7c1d6f", 4, 450, 5), 100);
  // 暗红粒子（杂乱散射）
  for (let i = 0; i < 14; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 3 + Math.random() * 4;
    const color = Math.random() < 0.5 ? "#dc2626" : "#991b1b";
    spawnDot(cx, cy, Math.cos(angle) * speed, Math.sin(angle) * speed - 1, color, 3, 550, 0.15);
  }
  // 下坠的黑气（走火入魔 = 气沉，与突破的上升相反）
  for (let i = 0; i < 6; i++) {
    const ox = (Math.random() - 0.5) * 30;
    spawnDot(cx + ox, cy, (Math.random() - 0.5) * 1, 2 + Math.random() * 2, "#450a0a", 3, 600, 0.1);
  }
  shakeAmp = 10;
  flashAlpha = 0.15; // 红闪
});

// 飞升 → 金光大作（持续金柱 + 大量上升金粒 + 多层扩散 + 强白闪）
listen("cult-ascension", () => {
  const cx = petX;
  const cy = petY - 30;
  // 多层金环（5 层错峰，模拟金光绽放）
  spawnRing(cx, cy, "#ffd700", 6, 900, 8);
  for (let i = 1; i <= 4; i++) {
    setTimeout(() => spawnRing(cx, cy, i % 2 === 0 ? "#ffffff" : "#ffd700", 6 + i, 800 - i * 80, 7 - i), i * 150);
  }
  // 大量上升金粒（飞升 = 升天，强烈向上的金光）
  const ascN = 40;
  for (let i = 0; i < ascN; i++) {
    const ox = (Math.random() - 0.5) * 60;
    const vy = -4 - Math.random() * 4;
    const vx = (Math.random() - 0.5) * 1.5;
    const color = Math.random() < 0.6 ? "#ffd700" : (Math.random() < 0.5 ? "#ffffff" : "#fff3c4");
    spawnDot(cx + ox, cy, vx, vy, color, 3 + Math.random() * 2, 1200 + Math.random() * 600, -0.01);
  }
  // 水平辐射金粒
  for (let i = 0; i < 20; i++) {
    const angle = (Math.PI * 2 * i) / 20;
    const speed = 5 + Math.random() * 3;
    spawnDot(cx, cy, Math.cos(angle) * speed, Math.sin(angle) * speed, "#ffd700", 4, 800, 0.03);
  }
  shakeAmp = 12;
  flashAlpha = 0.35;
  // 持续 2 秒的金光上升（分批再补一波）
  setTimeout(() => {
    for (let i = 0; i < 25; i++) {
      const ox = (Math.random() - 0.5) * 50;
      spawnDot(cx + ox, cy + 20, (Math.random() - 0.5) * 1, -5 - Math.random() * 3, "#ffd700", 3, 1200, -0.01);
    }
    flashAlpha = Math.max(flashAlpha, 0.15);
  }, 1500);
});

// 续命丹救命 → 绿色护盾（环形护盾 + 绿色粒子上升恢复）
listen("life-saved", () => {
  const cx = petX;
  const cy = petY - 30;
  // 双层绿色护盾环
  spawnRing(cx, cy, "#34d399", 2.5, 600, 5);
  setTimeout(() => spawnRing(cx, cy, "#6ee7b7", 3, 500, 4), 120);
  // 绿色恢复粒子（向上飘，生机感）
  for (let i = 0; i < 12; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 2 + Math.random() * 2;
    spawnDot(cx, cy, Math.cos(angle) * speed, Math.sin(angle) * speed - 2, "#34d399", 3, 600, -0.03);
  }
  flashAlpha = 0.1;
});

// 存款首达500彩蛋 → 神秘金光觉醒（克制、暗示性，不爆炸）
listen("savings-milestone", () => {
  const cx = petX;
  const cy = petY - 30;
  // 缓慢扩散的金环（暗示有什么被触发了）
  spawnRing(cx, cy, "#ffd700", 1.5, 1200, 3);
  setTimeout(() => spawnRing(cx, cy, "#ffe9a8", 2, 1000, 2.5), 300);
  // 少量上升的金色灵气（神秘感）
  for (let i = 0; i < 8; i++) {
    const ox = (Math.random() - 0.5) * 30;
    spawnDot(cx + ox, cy, (Math.random() - 0.5) * 0.3, -1.5 - Math.random(), "#fff3c4", 2.5, 1500, -0.01);
  }
  // 轻微金闪
  flashAlpha = 0.08;
});

// ===== 法术特效（商店施展，全屏震撼）=====
listen("spell-cast", (event) => {
  const spell = event.payload;
  const cx = petX;
  const cy = petY - 30;
  switch (spell) {
    case "fireball": return spellFireball(cx, cy);
    case "ice": return spellIce(cx, cy);
    case "thunder": return spellThunder(cx, cy);
    case "swords": return spellSwords(cx, cy);
    case "armageddon": return spellArmageddon(cx, cy);
  }
});

// 火球术：红橙火球爆裂 + 火焰粒子向外扩散（1.5s）
function spellFireball(cx, cy) {
  // ===== 第一阶段：蓄力（0-300ms）——中心火球凝聚 =====
  for (let i = 0; i < 8; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 20 + Math.random() * 15;
    spawnDot(cx + Math.cos(angle) * dist, cy + Math.sin(angle) * dist, -Math.cos(angle) * 2, -Math.sin(angle) * 2, "#ff4400", 4, 300, 0);
  }
  // ===== 第二阶段：引爆（300ms）——大冲击波 + 火球辐射 =====
  setTimeout(() => {
    // 双层冲击波（橙→白）
    spawnShockwave(cx, cy, "#ff6600", 100, 500);
    setTimeout(() => spawnShockwave(cx, cy, "#ffaa00", 80, 400), 80);
    // 中心闪光柱（向上喷射）
    spawnBeam(cx, cy, -Math.PI / 2, 80, 12, "#ffaa00", 400);
    // 火球图标向外辐射（带旋转拖尾感）
    for (let i = 0; i < 16; i++) {
      const angle = (Math.PI * 2 * i) / 16 + Math.random() * 0.2;
      const speed = 4 + Math.random() * 5;
      spawnSpellParticle("fireball", cx, cy, Math.cos(angle) * speed, Math.sin(angle) * speed - 2, 18, 900, 0.06, Math.random() * Math.PI);
    }
    // 火焰碎片（暗红，向外炸开后下坠）
    for (let i = 0; i < 24; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 3 + Math.random() * 6;
      const colors = ["#ff4400", "#ff6600", "#cc2200", "#ffaa00"];
      spawnDot(cx, cy, Math.cos(angle) * speed, Math.sin(angle) * speed - 3, colors[Math.floor(Math.random() * 4)], 3, 1000, 0.12);
    }
    // 烟雾（灰色，缓慢上升扩散）
    for (let i = 0; i < 8; i++) {
      const angle = Math.random() * Math.PI * 2;
      spawnDot(cx + Math.cos(angle) * 10, cy + Math.sin(angle) * 10, Math.cos(angle) * 0.5, -1 - Math.random(), "rgba(80,60,50,0.4)", 8, 1500, -0.02);
    }
    shakeAmp = 10;
    flashAlpha = 0.25;
  }, 300);
  // ===== 第三阶段：余烬（800ms）——火星上飘 =====
  setTimeout(() => {
    for (let i = 0; i < 15; i++) {
      const ox = (Math.random() - 0.5) * 40;
      spawnDot(cx + ox, cy, (Math.random() - 0.5) * 1, -2 - Math.random() * 2, "#ff8800", 2, 1200, -0.03);
    }
    spawnShockwave(cx, cy, "#ff4400", 60, 400);
  }, 800);
}

// 冰封术：冰晶六角绽放 + 冰锥上刺 + 霜冻裂纹 + 寒气扩散
function spellIce(cx, cy) {
  // ===== 第一阶段：凝聚（0-200ms）——蓝色能量收束 =====
  for (let i = 0; i < 6; i++) {
    const angle = Math.random() * Math.PI * 2;
    spawnDot(cx + Math.cos(angle) * 25, cy + Math.sin(angle) * 25, -Math.cos(angle) * 2, -Math.sin(angle) * 2, "#80c0ff", 5, 200, 0);
  }
  // ===== 第二阶段：绽放（200ms）——六角冰晶 + 多层霜冻 =====
  setTimeout(() => {
    // 六角冰晶图案（6条光芒线 + 中心爆裂）
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI * 2 * i) / 6;
      // 光芒线
      spawnBeam(cx, cy, angle, 50, 4, "#a0e0ff", 500);
      // 冰晶图标沿光芒散射
      spawnSpellParticle("ice", cx, cy, Math.cos(angle) * 3, Math.sin(angle) * 3, 16, 1200, -0.01, angle);
    }
    // 多层霜冻冲击波（蓝白交替，慢扩散）
    spawnShockwave(cx, cy, "#a0e0ff", 120, 1000);
    setTimeout(() => spawnShockwave(cx, cy, "#ffffff", 100, 800), 150);
    setTimeout(() => spawnShockwave(cx, cy, "#c0eaff", 80, 600), 300);
    // 冰锥从地面向上刺出（6根）
    for (let i = 0; i < 6; i++) {
      const angle = Math.PI + (Math.random() - 0.5) * Math.PI; // 偏下方
      const dist = 30 + Math.random() * 30;
      const ix = cx + Math.cos(angle) * dist;
      const iy = cy + Math.abs(Math.sin(angle)) * dist;
      // 冰锥向上喷射
      spawnBeam(ix, iy, -Math.PI / 2 + (Math.random() - 0.5) * 0.3, 25, 5, "#b0d0ff", 600);
      spawnDot(ix, iy, 0, -2, "#e0f0ff", 4, 800, 0.05);
    }
    // 冰雾（白雾下沉扩散）
    for (let i = 0; i < 16; i++) {
      const ox = (Math.random() - 0.5) * 80;
      spawnDot(cx + ox, cy, (Math.random() - 0.5) * 1, 1 + Math.random() * 0.5, "rgba(200,230,255,0.5)", 6, 1800, 0.005);
    }
    // 冰晶碎片飘散
    for (let i = 0; i < 10; i++) {
      const angle = Math.random() * Math.PI * 2;
      spawnDot(cx, cy, Math.cos(angle) * 2, Math.sin(angle) * 2 - 1, "#e0f0ff", 2, 1500, -0.01);
    }
    flashAlpha = 0.2;
  }, 200);
  // ===== 第三阶段：余寒（1000ms）——持续飘雪 =====
  setTimeout(() => {
    for (let i = 0; i < 12; i++) {
      const ox = (Math.random() - 0.5) * 100;
      const oy = -Math.random() * 40;
      spawnDot(cx + ox, cy + oy, (Math.random() - 0.5) * 0.5, 0.5 + Math.random(), "#ffffff", 1.5, 2000, 0);
    }
  }, 1000);
}

// 雷劫术：分叉闪电树 + 落雷光柱 + 电弧残留 + 强震
function spellThunder(cx, cy) {
  const thunderColor = "#b080ff";
  const coreColor = "#ffffff";
  // ===== 3 道落雷（错峰 500ms） =====
  for (let flash = 0; flash < 3; flash++) {
    setTimeout(() => {
      // 主闪电：从屏幕顶部劈到桌宠位置（带3条分叉）
      const startX = cx + (Math.random() - 0.5) * 150;
      spawnLightning(startX, 0, cx, cy, thunderColor, 350, 3);
      // 落雷点光柱（垂直发光柱）
      spawnBeam(cx, cy, -Math.PI / 2, 60, 15, thunderColor, 300);
      spawnBeam(cx, cy, -Math.PI / 2, 40, 8, coreColor, 250);
      // 落地冲击波
      spawnShockwave(cx, cy, thunderColor, 90, 400);
      // 电弧四散（向外辐射的闪电分支）
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI * 2 * i) / 6 + Math.random() * 0.3;
        const dist = 30 + Math.random() * 20;
        spawnLightning(cx, cy, cx + Math.cos(angle) * dist, cy + Math.sin(angle) * dist, thunderColor, 300, 1);
      }
      // 紫色电火花粒子
      for (let i = 0; i < 16; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 4 + Math.random() * 5;
        spawnDot(cx, cy, Math.cos(angle) * speed, Math.sin(angle) * speed, Math.random() < 0.3 ? coreColor : thunderColor, 3, 500, 0.1);
      }
      // 闪电图标（有则用）
      spawnSpellParticle("thunder", cx, cy - 20, 0, 0, 18, 350, 0, Math.random() * Math.PI);
      shakeAmp = 14;
      flashAlpha = 0.25;
    }, flash * 500);
  }
  // ===== 电弧残留（最后一次落雷后持续闪烁） =====
  setTimeout(() => {
    for (let i = 0; i < 4; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 20 + Math.random() * 30;
      spawnLightning(cx, cy, cx + Math.cos(angle) * dist, cy + Math.sin(angle) * dist, thunderColor, 200, 0);
    }
  }, 1600);
}

// 万剑诀：聚剑→剑阵旋转→万剑齐发→归宗收束（经典四段式）
// 设定参考：以意念驱剑，数十柄飞剑悬浮编队，旋转汇聚后锁定目标齐射，
// 攻击完毕万剑归宗收回。出自风云/蜀山传经典武侠仙侠设定。
function spellSwords(cx, cy) {
  const swordColor = "#ffd700";
  // ===== 第一阶段：聚剑（0-500ms）——四面八方飞剑汇聚到头顶 =====
  for (let i = 0; i < 12; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 120 + Math.random() * 80;
    const sx = cx + Math.cos(angle) * dist;
    const sy = cy - 50 + Math.sin(angle) * dist * 0.5;
    // 飞剑朝中心飞行
    const vx = (cx - sx) / 30;
    const vy = (cy - 50 - sy) / 30;
    spawnFlyingSword(sx, sy, vx, vy, Math.atan2(vy, vx) + Math.PI / 2, 20 + Math.random() * 8, swordColor, 500);
  }
  // ===== 第二阶段：剑阵旋转（500ms）——12柄剑环形悬浮，旋转加速 =====
  setTimeout(() => {
    spawnSwordArray(cx, cy, 12, 60, swordColor);
    // 剑阵下方金光法阵
    spawnShockwave(cx, cy - 20, swordColor, 70, 1200);
    flashAlpha = 0.1;
  }, 500);
  // ===== 第三阶段：万剑齐发（1.5s）——剑阵炸开，万剑向四周齐射 =====
  setTimeout(() => {
    // 剑阵收束后炸开——清空剑阵
    swordArrayParticles = [];
    // 万剑齐发：24柄光剑从中心向外辐射（如星河瀑布）
    for (let i = 0; i < 24; i++) {
      const angle = (Math.PI * 2 * i) / 24 + Math.random() * 0.15;
      const speed = 8 + Math.random() * 4;
      spawnFlyingSword(cx, cy - 20, Math.cos(angle) * speed, Math.sin(angle) * speed, angle + Math.PI / 2, 28 + Math.random() * 8, swordColor, 800);
      // 剑光拖尾
      spawnBeam(cx, cy - 20, angle, 40, 3, swordColor, 300);
    }
    // 中心爆发
    spawnShockwave(cx, cy - 20, "#ffffff", 100, 600);
    spawnShockwave(cx, cy - 20, swordColor, 130, 800);
    // 金色粒子填充
    for (let i = 0; i < 20; i++) {
      const angle = Math.random() * Math.PI * 2;
      spawnDot(cx, cy - 20, Math.cos(angle) * 5, Math.sin(angle) * 5, swordColor, 3, 700, 0.02);
    }
    shakeAmp = 12;
    flashAlpha = 0.2;
  }, 1500);
  // ===== 第四阶段：归宗收束（2.5s）——所有剑回收汇聚成一束光 =====
  setTimeout(() => {
    // 万剑归宗：从四周飞回中心
    for (let i = 0; i < 16; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 100 + Math.random() * 60;
      const sx = cx + Math.cos(angle) * dist;
      const sy = cy - 20 + Math.sin(angle) * dist * 0.5;
      const vx = (cx - sx) / 20;
      const vy = (cy - 20 - sy) / 20;
      spawnFlyingSword(sx, sy, vx, vy, Math.atan2(vy, vx) + Math.PI / 2, 18, swordColor, 400);
    }
    // 汇聚光柱（向上冲天）
    setTimeout(() => {
      spawnBeam(cx, cy - 20, -Math.PI / 2, 120, 10, "#ffffff", 500);
      spawnBeam(cx, cy - 20, -Math.PI / 2, 100, 6, swordColor, 600);
      spawnShockwave(cx, cy - 20, swordColor, 80, 500);
      flashAlpha = 0.15;
    }, 350);
  }, 2500);
}

// 天地同寿：五色法阵 + 旋转光柱 + 全屏冲击波（4s，终极）
function spellArmageddon(cx, cy) {
  const colors = ["#ffd700", "#22c55e", "#3b82f6", "#ef4444", "#a855f7"]; // 金木水火土
  // ===== 第一阶段：法阵展开（0-800ms）——五色法阵旋转凝聚 =====
  for (let phase = 0; phase < 4; phase++) {
    setTimeout(() => {
      // 法阵环（每层不同颜色，旋转扩散）
      const color = colors[phase];
      spawnShockwave(cx, cy, color, 60 + phase * 20, 800);
      // 法阵光芒线（五角星方向）
      for (let i = 0; i < 5; i++) {
        const angle = (Math.PI * 2 * i) / 5 + phase * 0.3;
        spawnBeam(cx, cy, angle, 40 + phase * 10, 3, color, 500);
      }
    }, phase * 200);
  }
  // ===== 第二阶段：五色光柱冲天（800ms-1.5s） =====
  setTimeout(() => {
    // 主光柱（白色核心 + 五色外层）
    spawnBeam(cx, cy, -Math.PI / 2, 200, 30, "#ffffff", 800);
    for (let i = 0; i < 5; i++) {
      const offset = (i - 2) * 6;
      spawnBeam(cx + offset, cy, -Math.PI / 2 + (i - 2) * 0.05, 180, 12, colors[i], 800);
    }
    // 五色粒子柱上升
    for (let c of colors) {
      for (let i = 0; i < 8; i++) {
        const ox = (Math.random() - 0.5) * 40;
        spawnDot(cx + ox, cy, (Math.random() - 0.5) * 1, -8 - Math.random() * 4, c, 5, 1500, -0.03);
      }
    }
    // 五色图标上升
    spawnSpellParticle("armageddon", cx, cy, 0, -6, 30, 1500, -0.02, 0);
    flashAlpha = 0.3;
    shakeAmp = 12;
  }, 800);
  // ===== 第三阶段：全屏绽放（1.8s）——终极爆发 =====
  setTimeout(() => {
    // 全屏冲击波（5层五色）
    for (let i = 0; i < 5; i++) {
      setTimeout(() => spawnShockwave(cx, cy, colors[i], 250, 1200), i * 80);
    }
    // 五色图标四散
    for (let i = 0; i < 15; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 5 + Math.random() * 6;
      spawnSpellParticle("armageddon", cx, cy, Math.cos(angle) * speed, Math.sin(angle) * speed, 28, 1800, 0.02, Math.random() * Math.PI);
    }
    // 五色光束辐射（全方向）
    for (let i = 0; i < 16; i++) {
      const angle = (Math.PI * 2 * i) / 16;
      spawnBeam(cx, cy, angle, 120, 6, colors[i % 5], 700);
    }
    // 彩色粒子全屏爆发
    for (let i = 0; i < 60; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 5 + Math.random() * 8;
      spawnDot(cx, cy, Math.cos(angle) * speed, Math.sin(angle) * speed, colors[Math.floor(Math.random() * 5)], 5, 1800, 0.02);
    }
    shakeAmp = 18;
    flashAlpha = 0.4;
  }, 1800);
}

// ===== 预渲染发光球（避免每帧 createRadialGradient 的性能开销）=====
const glowCache = {};
function getGlow(color, size) {
  const key = `${color}_${size}`;
  if (glowCache[key]) return glowCache[key];
  const r = size * 3;
  const off = document.createElement("canvas");
  off.width = r * 2;
  off.height = r * 2;
  const octx = off.getContext("2d");
  const g = octx.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0, color);
  g.addColorStop(0.4, color);
  g.addColorStop(1, "rgba(0,0,0,0)");
  octx.fillStyle = g;
  octx.fillRect(0, 0, r * 2, r * 2);
  glowCache[key] = off;
  return off;
}

// ===== 渲染循环 =====
function render(now) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 粒子空时跳过（降耗）
  if (particles.length === 0 && symbols.length === 0 && swordArrayParticles.length === 0 && shakeAmp < 0.1 && flashAlpha < 0.01) {
    requestAnimationFrame(render);
    return;
  }

  // Screen shake
  let sx = 0, sy = 0;
  if (shakeAmp > 0.1) {
    sx = (Math.random() - 0.5) * shakeAmp;
    sy = (Math.random() - 0.5) * shakeAmp;
    shakeAmp *= 0.85;
  }
  ctx.save();
  ctx.translate(sx, sy);

  // ===== 发光粒子（加法混合）=====
  ctx.globalCompositeOperation = "lighter";
  const aliveP = [];
  for (const p of particles) {
    const age = now - p.born;
    if (age >= p.life) continue;
    const t = age / p.life;
    const alpha = (1 - t) * (1 - t); // 平方衰减

    if (p.vx !== undefined) p.x += p.vx;
    if (p.vy !== undefined) { p.y += p.vy; if (p.gravity) p.vy += p.gravity; }
    if (p.type === "ring") p.radius += p.vrad || 2;

    // 出生脉冲：前 60ms 从 0 弹到最大
    let scale = 1;
    if (age < 60) {
      scale = age / 60;
      scale = 1 - (1 - scale) * (1 - scale); // ease-out
    }

    ctx.globalAlpha = alpha * scale;

    if (p.type === "dot") {
      // 用预渲染发光球贴图（比 createRadialGradient 快 10 倍）
      const glow = getGlow(p.color, p.size);
      const r = p.size * 3 * scale;
      ctx.drawImage(glow, p.x - r, p.y - r, r * 2, r * 2);
    } else if (p.type === "icon") {
      // 法术图标粒子：跳过 lighter 循环，单独渲染（见下方）
    } else if (p.type === "ring") {
      // 冲击波：粗→细 + 发光
      ctx.strokeStyle = p.color;
      ctx.lineWidth = (p.lineWidth || 4) * (1 - t * 0.7) * scale;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 20 * (1 - t);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
    } else if (p.type === "shockwave") {
      // 厚冲击波：带径向渐变填充的环（比 ring 更有体积感）
      p.radius = 4 + (p.maxRadius - 4) * t;
      const innerR = p.radius * 0.7;
      const g = ctx.createRadialGradient(p.x, p.y, innerR, p.x, p.y, p.radius);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(0.6, p.color.replace(")", `,${alpha * 0.3})`).replace("rgb", "rgba"));
      g.addColorStop(0.85, p.color);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
      // 外圈高光描边
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 2 * (1 - t);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.stroke();
    } else if (p.type === "beam") {
      // 光束：矩形，沿角度方向，带渐变
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      const g = ctx.createLinearGradient(0, -p.width / 2, 0, p.width / 2);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(0.5, p.color);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      const w = p.width * (1 - t * 0.5) * scale;
      ctx.fillRect(0, -w / 2, p.length * scale, w);
      // 核心亮线
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.fillRect(0, -1, p.length * scale, 2);
      ctx.restore();
    } else if (p.type === "lightning") {
      // 闪电：锯齿折线 + 发光 + 白色核心
      // 外层光晕
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 6 * (1 - t);
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 15;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = 0; i < p.points.length; i++) {
        if (i === 0) ctx.moveTo(p.points[i].x, p.points[i].y);
        else ctx.lineTo(p.points[i].x, p.points[i].y);
      }
      ctx.stroke();
      // 白色核心
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 2 * (1 - t);
      ctx.shadowBlur = 8;
      ctx.beginPath();
      for (let i = 0; i < p.points.length; i++) {
        if (i === 0) ctx.moveTo(p.points[i].x, p.points[i].y);
        else ctx.lineTo(p.points[i].x, p.points[i].y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    } else if (p.type === "sword") {
      // 程序绘制光剑：剑身渐变 + 剑脊高光 + 剑格 + 剑尖星芒
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      const L = p.length * scale;
      // 剑身（渐变长条：柄→刃→尖）
      const g = ctx.createLinearGradient(0, 0, L, 0);
      g.addColorStop(0, "rgba(180,140,40,0.6)"); // 剑柄
      g.addColorStop(0.2, p.color); // 剑格处
      g.addColorStop(0.4, p.color);
      g.addColorStop(0.8, "rgba(255,250,200,0.9)"); // 剑刃亮
      g.addColorStop(1, "rgba(255,255,255,1)"); // 剑尖白
      ctx.fillStyle = g;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 8 * (1 - t * 0.5);
      // 剑身（尖头三角形）
      ctx.beginPath();
      ctx.moveTo(0, -1.5);
      ctx.lineTo(L * 0.8, -1.5);
      ctx.lineTo(L, 0);
      ctx.lineTo(L * 0.8, 1.5);
      ctx.lineTo(0, 1.5);
      ctx.closePath();
      ctx.fill();
      // 剑脊高光线
      ctx.strokeStyle = "rgba(255,255,255,0.8)";
      ctx.lineWidth = 0.8;
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.moveTo(L * 0.2, 0);
      ctx.lineTo(L * 0.9, 0);
      ctx.stroke();
      // 剑格（十字横档）
      ctx.fillStyle = p.color;
      ctx.fillRect(L * 0.15, -3, 2, 6);
      // 剑尖星芒（十字光）
      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.lineWidth = 1;
      const tipX = L;
      ctx.beginPath();
      ctx.moveTo(tipX - 4, 0); ctx.lineTo(tipX + 4, 0);
      ctx.moveTo(tipX, -3); ctx.lineTo(tipX, 3);
      ctx.stroke();
      ctx.restore();
    }
    aliveP.push(p);
  }
  particles = aliveP;

  // ===== 剑阵渲染（万剑诀专属：环形悬浮剑旋转收束）=====
  if (swordArrayParticles.length > 0) {
    ctx.globalCompositeOperation = "lighter";
    const aliveArr = [];
    for (const sa of swordArrayParticles) {
      const age = now - sa.born;
      if (age >= sa.life) continue;
      const t = age / sa.life;
      // 旋转角度（随时间加快）
      const rotSpeed = t < 0.6 ? 2 + t * 3 : 5; // 展开时加速
      const rotAngle = sa.baseAngle + age / 1000 * rotSpeed * Math.PI;
      // 半径：先展开(0→radius)，后收束(radius→0)
      let r;
      if (t < 0.3) { r = sa.radius * (t / 0.3); } // 展开
      else if (t < 0.7) { r = sa.radius; } // 保持
      else { r = sa.radius * (1 - (t - 0.7) / 0.3); } // 收束
      const px = sa.cx + Math.cos(rotAngle) * r;
      const py = sa.cy + Math.sin(rotAngle) * r * 0.4 - 30; // 椭圆轨道，略偏上
      // 剑身朝向：沿切线方向（旋转方向）
      const swordAngle = rotAngle + Math.PI / 2;
      const alpha = t < 0.8 ? 1 : (1 - t) / 0.2;
      ctx.globalAlpha = alpha;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(swordAngle);
      const L = sa.length;
      // 简化剑身
      const g = ctx.createLinearGradient(0, 0, L, 0);
      g.addColorStop(0, "rgba(180,140,40,0.5)");
      g.addColorStop(0.3, sa.color);
      g.addColorStop(1, "rgba(255,255,255,1)");
      ctx.fillStyle = g;
      ctx.shadowColor = sa.color;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.moveTo(0, -1.2); ctx.lineTo(L * 0.8, -1.2); ctx.lineTo(L, 0);
      ctx.lineTo(L * 0.8, 1.2); ctx.lineTo(0, 1.2); ctx.closePath();
      ctx.fill();
      ctx.restore();
      aliveArr.push(sa);
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    swordArrayParticles = aliveArr;
  }

  // ===== 法术图标粒子（source-over，保留原图色彩）=====
  ctx.globalCompositeOperation = "source-over";
  for (const p of particles) {
    if (p.type !== "icon") continue;
    const age = now - p.born;
    if (age >= p.life) continue;
    const t = age / p.life;
    const alpha = (1 - t) * (1 - t);
    if (p.rotation !== undefined) p.rotation += p.spin || 0;
    let scale = 1;
    if (age < 60) { scale = age / 60; scale = 1 - (1 - scale) * (1 - scale); }
    ctx.globalAlpha = alpha * scale;
    ctx.save();
    ctx.translate(p.x, p.y);
    if (p.rotation) ctx.rotate(p.rotation);
    const s = p.size * scale;
    ctx.drawImage(p.img, -s / 2, -s / 2, s, s);
    ctx.restore();
  }
  ctx.globalAlpha = 1;

  // 白闪（加法混合下叠加白色 = 过曝感）
  if (flashAlpha > 0.01) {
    ctx.globalAlpha = flashAlpha;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    flashAlpha *= 0.7;
  }

  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;

  // ===== 代码符号（单独渲染，带 glow，不走 lighter）=====
  const aliveS = [];
  for (const s of symbols) {
    const age = now - s.born;
    if (age >= s.life) continue;
    const t = age / s.life;
    const alpha = (1 - t) * (1 - t);
    s.x += s.vx;
    s.y += s.vy;
    s.vy += s.gravity;

    ctx.globalAlpha = alpha;
    ctx.shadowColor = s.color;
    ctx.shadowBlur = 10;
    ctx.fillStyle = s.color;
    ctx.font = "bold 16px monospace";
    ctx.fillText(s.text, Math.round(s.x), Math.round(s.y));
    aliveS.push(s);
  }
  symbols = aliveS;
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;

  ctx.restore();
  requestAnimationFrame(render);
}
requestAnimationFrame(render);
