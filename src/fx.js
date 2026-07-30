// Overworked 全屏特效层（fx-overlay 窗口）
//
// 酷炫粒子系统：加法混合 + 发光球 + 冲击波 + screen shake。
// 打字→桌宠头顶爆裂（能量溢出）；点击→实际点击坐标爆发。
// 点击穿透，不影响下层操作。

const { listen } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;
const win = getCurrentWindow();

const canvas = document.getElementById("fx-canvas");
const ctx = canvas.getContext("2d");

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

function spawnDot(x, y, vx, vy, color, size, life, gravity) {
  if (particles.length > 60) return;
  particles.push({ type: "dot", x, y, vx, vy, color, size: size || 3, life: life || 350, gravity: gravity || 0.1, born: performance.now() });
}
function spawnRing(x, y, color, vrad, life, lineWidth) {
  if (particles.length > 60) return;
  particles.push({ type: "ring", x, y, radius: 6, vrad: vrad || 2.5, color, life: life || 300, lineWidth: lineWidth || 4, born: performance.now() });
}
function spawnSymbol(text, x, y, vx, vy, color) {
  if (symbols.length > 8) return;
  symbols.push({ text, x, y, vx, vy, color, life: 700, gravity: 0.08, born: performance.now() });
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

// ===== 渲染循环 =====
function render(now) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 粒子空时跳过（降耗）
  if (particles.length === 0 && symbols.length === 0 && shakeAmp < 0.1 && flashAlpha < 0.01) {
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
      // 发光球：径向渐变
      const r = p.size * 3 * scale;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      g.addColorStop(0, p.color);
      g.addColorStop(0.4, p.color);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
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
    }
    aliveP.push(p);
  }
  particles = aliveP;

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
