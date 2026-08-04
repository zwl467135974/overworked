// 天工阁 —— 修仙商店前端
//
// 设计：修仙模式放开红线（数值全可见、游戏化 UI、主动提示）。
// 普通模式：只显示"开启修仙"按钮。
// 修仙模式：境界/修为/灵石/背包/道具/坐骑/法术全可见。

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ===== 静态数据表 =====
const MOUNTS = [
  { id: 1, key: "mount_sword", name: "飞剑", icon: "剑", price: 1000, minRealm: 1, desc: "银白剑身，灵光拖尾" },
  { id: 2, key: "mount_gourd", name: "葫芦", icon: "芦", price: 2000, minRealm: 2, desc: "金色酒葫芦，缭绕灵气" },
  { id: 3, key: "mount_dragon", name: "青龙", icon: "龙", price: 5000, minRealm: 3, desc: "青龙盘绕，龙鳞流光" },
  { id: 4, key: "mount_qilin", name: "麒麟", icon: "麟", price: 8000, minRealm: 4, desc: "金色瑞兽，脚踏祥云" },
  { id: 5, key: "mount_phoenix", name: "凤凰", icon: "凤", price: 15000, minRealm: 5, desc: "火凤展翅，烈焰拖尾" },
];
const SPELLS = [
  { key: "fireball",  name: "火球术",   icon: "火", price: 300,  staminaCost: 10, gainExp: 5,  gainWage: 3,  desc: "红橙火球爆裂 · 心魔+5(烈焰躁动)" },
  { key: "ice",       name: "冰封术",   icon: "冰", price: 600,  staminaCost: 15, gainExp: 8,  gainWage: 5,  desc: "蓝白冰晶绽放 · 净心-15(冰心诀)" },
  { key: "thunder",   name: "雷劫术",   icon: "雷", price: 1200, staminaCost: 20, gainExp: 12, gainWage: 8,  desc: "紫白闪电劈下 · 炼心-10(以雷炼心)" },
  { key: "swords",    name: "万剑诀",   icon: "剑", price: 3000, staminaCost: 30, gainExp: 18, gainWage: 12, desc: "数十光剑天降 · 剑心-5(通明)" },
  { key: "armageddon", name: "天地同寿", icon: "灭", price: 8000, staminaCost: 45, gainExp: 25, gainWage: 18, desc: "五色光柱冲天 · 净心-20(大道至简)" },
];
const ITEM_PRICE = {
  qi_pill: 50,
  life_pill: 100,
  spirit_talisman: 200,
};

// DOM
const numSavings = document.getElementById("num-savings");
const realmName = document.getElementById("realm-name");
const barExp = document.getElementById("bar-exp");
const expText = document.getElementById("exp-text");
const nextRealm = document.getElementById("next-realm");
const btnToggleMode = document.getElementById("btn-toggle-mode");
const modeHint = document.getElementById("mode-hint");
const shopSection = document.getElementById("shop-section");
const mountSection = document.getElementById("mount-section");
const spellSection = document.getElementById("spell-section");
const invSection = document.getElementById("inv-section");
const taskSection = document.getElementById("task-section");
const toast = document.getElementById("toast");
const priceBreakthrough = document.getElementById("price-breakthrough_pill");
const priceHeartDevil = document.getElementById("price-heart_devil_pill");
const mountList = document.getElementById("mount-list");
const spellList = document.getElementById("spell-list");

const REALM_NAMES = ["凡人", "练气", "筑基", "金丹", "元婴", "化神", "飞升"];

/** 渲染坐骑列表 */
function renderMounts(data) {
  mountList.innerHTML = "";
  for (const m of MOUNTS) {
    const owned = data.owned_mounts[m.id - 1];
    const equipped = data.equipped_mount === m.id;
    const realmLocked = data.realm < m.minRealm;
    const card = document.createElement("div");
    card.className = "item-card";
    card.innerHTML = `
      <div class="item-icon mount-icon">${m.icon}</div>
      <div class="item-info">
        <div class="item-name">${m.name}${realmLocked ? ` <span class="lock-tag">需${REALM_NAMES[m.minRealm]}</span>` : ""}</div>
        <div class="item-desc">${m.desc}</div>
      </div>
      <div class="item-right">
        ${owned ? "" : `<div class="item-price">${m.price}</div>`}
        ${equipped
          ? `<button class="btn-equipped" disabled>装备中</button>`
          : owned
            ? `<button class="btn-equip" data-mount="${m.id}">装备</button>`
            : `<button class="btn-buy" data-item="${m.key}" ${data.savings < m.price || realmLocked ? "disabled" : ""}>购买</button>`}
      </div>
    `;
    mountList.appendChild(card);
  }
}

/** 渲染法术列表（永久解锁制：买一次永久拥有，施法消耗体力） */
function renderSpells(data) {
  spellList.innerHTML = "";
  for (const s of SPELLS) {
    const owned = data.spells[SPELLS.indexOf(s)] > 0;
    const stamina = data.stamina || 0;
    const canCast = owned && stamina >= s.staminaCost;
    const card = document.createElement("div");
    card.className = "item-card";
    card.innerHTML = `
      <div class="item-icon spell-icon">${s.icon}</div>
      <div class="item-info">
        <div class="item-name">${s.name} ${owned ? `<span class="owned-tag">✓已习得</span>` : ""}</div>
        <div class="item-desc">${s.desc}${owned ? ` · 耗体力${s.staminaCost} 修为+${s.gainExp}${data.equipped_mount > 0 ? "×1.5" : ""} 时薪+${s.gainWage}${data.equipped_mount > 0 ? ' <span style="color:#6ad7c1">·坐骑共鸣</span>' : ""}` : ""}</div>
      </div>
      <div class="item-right">
        ${owned ? "" : `<div class="item-price">${s.price}</div>`}
        <div class="btn-group">
          ${owned
            ? `<button class="btn-cast" data-spell="${s.key}" ${canCast ? "" : "disabled"}>施展(-${s.staminaCost})</button>`
            : `<button class="btn-buy" data-item="${s.key}" ${data.savings < s.price ? "disabled" : ""}>购买</button>`
          }
        </div>
      </div>
    `;
    spellList.appendChild(card);
  }
}

/** 渲染商店数据 */
function render(data) {
  numSavings.textContent = Math.floor(data.savings);
  realmName.textContent = data.realm_name;
  const pct = Math.max(0, Math.min(100, data.exp));
  barExp.style.width = pct + "%";
  expText.textContent = Math.floor(data.exp) + "/100";
  nextRealm.textContent = data.next_realm;
  if (priceBreakthrough) priceBreakthrough.textContent = data.breakthrough_price;
  if (priceHeartDevil) priceHeartDevil.textContent = data.heart_devil_pill_price;
  // 突破成功率标签
  const rateTag = document.getElementById("breakthrough-rate-tag");
  if (rateTag) rateTag.textContent = `成功率 ${data.breakthrough_rate}%`;
  // 心魔值显示
  const demonDisplay = document.getElementById("demon-display");
  const demonValue = document.getElementById("demon-value");
  const demonEffect = document.getElementById("demon-effect");
  if (demonDisplay && demonValue) {
    const d = Math.floor(data.inner_demon || 0);
    if (d > 0) {
      demonDisplay.hidden = false;
      demonValue.textContent = d;
      if (demonEffect) {
        if (d < 30) demonEffect.textContent = "· 清心";
        else if (d < 60) demonEffect.textContent = "· 侵扰(修为-20% 突破-10%)";
        else if (d < 80) demonEffect.textContent = "· 缠绕(修为-40% 突破-20%)";
        else demonEffect.textContent = "· 走火边缘(修为-60% 突破-30%)";
      }
    } else {
      demonDisplay.hidden = true;
    }
  }
  // 心魔丹计数
  const hdCount = document.getElementById("heart-devil-count");
  if (hdCount) hdCount.textContent = `${data.heart_devil_pills_used}/3`;
  document.getElementById("cnt-qi_pill").textContent = data.qi_pill;
  document.getElementById("cnt-life_pill").textContent = data.life_pill;
  document.getElementById("cnt-spirit_talisman").textContent = data.spirit_talisman;

  if (data.cultivation_mode) {
    btnToggleMode.textContent = "化凡（做回凡人）";
    btnToggleMode.classList.add("off");
    modeHint.textContent = "修仙模式：境界/修为/灵石全开。打工、专注、交付皆可积累修为。化凡后可随时重入，无需再花灵石。";
    shopSection.hidden = false;
    mountSection.hidden = false;
    spellSection.hidden = false;
    invSection.hidden = false;
    taskSection.hidden = false;
    renderMounts(data);
    renderSpells(data);
    renderTasks(data);
    if (data.realm >= 6) {
      const btn = document.querySelector('[data-item="breakthrough_pill"]');
      if (btn) { btn.disabled = true; btn.textContent = "已飞升"; }
    }
    // 心魔丹按钮：已用完或已飞升则禁用
    const hdBtn = document.querySelector('[data-item="heart_devil_pill"]');
    if (hdBtn) hdBtn.disabled = data.heart_devil_pills_used >= 3 || data.realm >= 6;
  } else if (data.ever_cultivated) {
    btnToggleMode.textContent = "重入修仙（免费）";
    btnToggleMode.classList.remove("off");
    modeHint.textContent = "道基犹在，随时可重入修仙，无需再花灵石。";
    shopSection.hidden = true;
    mountSection.hidden = true;
    spellSection.hidden = true;
    invSection.hidden = true;
    taskSection.hidden = true;
  } else {
    btnToggleMode.textContent = "开启修仙之路（500 灵石）";
    btnToggleMode.classList.remove("off");
    const enough = data.savings >= 500;
    modeHint.textContent = enough
      ? "灵石充足，踏入修仙。普通模式守规矩，修仙模式见真章。"
      : "还需 " + (500 - Math.floor(data.savings)) + " 灵石才能踏入修仙。继续打工攒钱吧。";
    shopSection.hidden = true;
    mountSection.hidden = true;
    spellSection.hidden = true;
    invSection.hidden = true;
    taskSection.hidden = true;
  }

  // 丹药按钮可用性
  document.querySelectorAll(".btn-buy").forEach((btn) => {
    if (btn.disabled) return;
    const item = btn.dataset.item;
    if (!item || item.startsWith("mount_") || item.startsWith("spell_")) return;
    const price = item === "breakthrough_pill" ? data.breakthrough_price : ITEM_PRICE[item];
    btn.disabled = data.savings < price;
  });
}

let toastTimer = null;
function showToast(msg, type = "") {
  toast.textContent = msg;
  toast.className = "toast show " + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = "toast " + type; }, 2200);
}

async function refresh() {
  try {
    const data = await invoke("get_shop_data");
    // 用模块级快照 lastStones/lastExp 对比新数据，累计任务进度
    trackDeltaTasks(data);
    window._lastShopData = data;
    // 首次刷新时从后端加载日常任务 + 成就
    if (dailyTaskState.length === 0 && !dailyTaskDate) {
      await loadDailyTasks(data.realm);
    }
    if (Object.keys(achievementState).length === 0) {
      await loadAchievements();
    }
    render(data);
    renderAchievements(data);
    // 检查成就触发（异步，不阻塞渲染）
    checkAchievements(data);
    // 移除加载提示
    const loading = document.getElementById("loading");
    if (loading) loading.remove();
  } catch (e) {
    console.error("get_shop_data", e);
    // 显示错误到页面
    const loading = document.getElementById("loading");
    if (loading) {
      loading.textContent = "加载失败: " + e;
      loading.style.color = "#ff6b6b";
    }
  }
}

async function buy(item) {
  try {
    await invoke("buy_item", { item });
    showToast("购买成功", "success");
  } catch (e) {
    showToast(String(e), "error");
  }
  await refresh();
}

async function equip(mountId) {
  try {
    await invoke("equip_mount", { mountId });
  } catch (e) {
    showToast(String(e), "error");
  }
  await refresh();
}

async function cast(spell) {
  try {
    await invoke("cast_spell", { spell });
    addTaskProgress("cast_spell", 1);
    showToast("施展！", "success");
  } catch (e) {
    showToast(String(e), "error");
  }
  await refresh();
}

async function toggleMode() {
  try {
    await invoke("toggle_cultivation");
    showToast("模式已切换", "success");
  } catch (e) {
    showToast(String(e), "error");
  }
  await refresh();
}

// ===== 成就系统 =====
const ACHIEVEMENTS = [
  { id: "first_cult",    icon: "🌟", name: "踏入仙途",   desc: "开启修仙模式",         reward: 0,   check: d => d.ever_cultivated },
  { id: "realm_2",       icon: "🔥", name: "筑基成功",   desc: "突破到筑基",           reward: 200, check: d => d.realm >= 2 },
  { id: "realm_3",       icon: "💊", name: "金丹大道",   desc: "凝成金丹",             reward: 500, check: d => d.realm >= 3 },
  { id: "realm_4",       icon: "👶", name: "元婴出窍",   desc: "元婴成形",             reward: 800, check: d => d.realm >= 4 },
  { id: "realm_5",       icon: "⚡", name: "化神渡劫",   desc: "扛过九雷",             reward: 1500, check: d => d.realm >= 5 },
  { id: "ascend",        icon: "✨", name: "飞升成仙",   desc: "踏入仙界",             reward: 5000, check: d => d.realm >= 6 },
  { id: "mount_1",       icon: "🦅", name: "御剑乘风",   desc: "装备任意坐骑",         reward: 100, check: d => d.equipped_mount > 0 },
  { id: "mount_all",     icon: "🐲", name: "灵兽满圈",   desc: "集齐5种坐骑",          reward: 2000, check: d => d.owned_mounts?.every(v => v) },
  { id: "spell_all",     icon: "📖", name: "万法归宗",   desc: "习得全部5种法术",      reward: 1000, check: d => d.spells?.every(v => v > 0) },
  { id: "demon_pure",    icon: "🧊", name: "冰心通明",   desc: "心魔降至0",            reward: 300, check: d => d.inner_demon !== undefined && d.inner_demon < 1 },
  { id: "overwork_5",    icon: "💀", name: "百死不悔",   desc: "过劳变异5次",          reward: 0,   check: d => d.pet_variant >= 5 },
  { id: "savings_5000",  icon: "💰", name: "灵石满仓",   desc: "灵石达5000",           reward: 0,   check: d => d.savings >= 5000 },
];
let achievementState = {}; // { id: true }

async function loadAchievements() {
  try {
    const json = await invoke("get_achievements");
    if (json) achievementState = JSON.parse(json);
  } catch (e) { console.warn("loadAchievements", e); }
}

async function checkAchievements(data) {
  let changed = false;
  for (const ach of ACHIEVEMENTS) {
    if (achievementState[ach.id]) continue;
    if (ach.check(data)) {
      achievementState[ach.id] = true;
      changed = true;
      // 奖励
      if (ach.reward > 0) {
        try { await invoke("claim_daily_reward", { spiritStones: ach.reward, exp: 0 }); } catch (e) {}
      }
      showToast(`🏆 ${ach.name}！${ach.reward > 0 ? `+${ach.reward}灵石` : ""}`, "success");
    }
  }
  if (changed) {
    try { await invoke("save_achievements", { data: JSON.stringify(achievementState) }); } catch (e) {}
    renderAchievements(data);
  }
}

function renderAchievements(data) {
  const container = document.getElementById("achievement-list");
  if (!container) return;
  container.innerHTML = "";
  for (const ach of ACHIEVEMENTS) {
    const unlocked = !!achievementState[ach.id];
    const card = document.createElement("div");
    card.className = `ach-card ${unlocked ? "unlocked" : "locked"}`;
    card.innerHTML = `
      <span class="ach-icon">${unlocked ? ach.icon : "🔒"}</span>
      <span class="ach-name">${unlocked ? ach.name : "？？？"}</span>
      <span class="ach-desc">${ach.desc}${ach.reward > 0 ? ` · ◈${ach.reward}` : ""}</span>
    `;
    container.appendChild(card);
  }
}

// ===== 事件绑定 =====
btnToggleMode.addEventListener("click", toggleMode);

// 事件委托：购买/装备/施展按钮（动态生成的元素）
document.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  if (btn.dataset.item) { buy(btn.dataset.item); }
  else if (btn.dataset.mount) { equip(parseInt(btn.dataset.mount)); }
  else if (btn.dataset.spell) { cast(btn.dataset.spell); }
});

listen("cultivation-update", () => refresh());
listen("stats-update", () => refresh());
listen("realm-up", () => { showToast("突破成功！", "success"); refresh(); });
listen("cult-deviation", () => { showToast("走火入魔！修为清零", "error"); refresh(); });
listen("cult-ascension", () => { showToast("恭喜飞升！", "success"); refresh(); });
listen("mount-equipped", () => refresh());
listen("spell-cast", () => { addTaskProgress("cast_spell", 1); refresh(); });
listen("pomodoro-complete", () => { addTaskProgress("pomodoro", 1); refresh(); });
listen("tauri://focus", () => refresh());

// ===== 日常任务系统（持久化到后端 settings 表）=====
const DAILY_TASKS = [
  { id: "work_stones", name: "打工攒灵石", desc: (n) => `打工获得 ${n} 灵石`, target: (realm) => 100 + realm * 50, reward_stones: 80, reward_exp: 5 },
  { id: "pomodoro", name: "专注修炼", desc: "完成 1 次专注（持续打字5分钟）", target: 1, reward_stones: 150, reward_exp: 15 },
  { id: "cast_spell", name: "施展法术", desc: "施展 1 次法术", target: 1, reward_stones: 100, reward_exp: 8 },
  { id: "idle_cultivate", name: "静心打坐", desc: "挂机积累修为 10 点", target: 10, reward_stones: 60, reward_exp: 10 },
];
let dailyTaskState = []; // [{task, progress, claimed}]
// 上一次刷新时的灵石/修为快照，用于增量计任务进度
let lastStones = null;
let lastExp = null;
// 今日日期标记（跨天重置任务）
let dailyTaskDate = "";

/** 获取今日日期字符串 YYYY-MM-DD */
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/** 从后端加载日常任务状态（含跨天重置） */
async function loadDailyTasks(realm) {
  try {
    const json = await invoke("get_daily_tasks");
    if (json) {
      const saved = JSON.parse(json);
      // 跨天重置：日期不同则重新生成
      if (saved.date === todayStr() && saved.tasks && saved.tasks.length > 0) {
        // 恢复保存的任务（把 id 映射回完整 task 定义）
        dailyTaskState = saved.tasks.map(s => {
          const task = DAILY_TASKS.find(t => t.id === s.id);
          return task ? { task, progress: s.progress || 0, claimed: !!s.claimed } : null;
        }).filter(Boolean);
        dailyTaskDate = saved.date;
        return;
      }
    }
  } catch (e) { console.warn("loadDailyTasks", e); }
  // 首次或跨天：生成新任务
  dailyTaskState = generateDailyTasks(realm);
  dailyTaskDate = todayStr();
  await persistDailyTasks();
}

/** 保存日常任务状态到后端 */
async function persistDailyTasks() {
  const data = {
    date: dailyTaskDate,
    tasks: dailyTaskState.map(dt => ({ id: dt.task.id, progress: dt.progress, claimed: dt.claimed })),
  };
  try {
    await invoke("save_daily_tasks", { data: JSON.stringify(data) });
  } catch (e) { console.warn("persistDailyTasks", e); }
}

/** 增加某个任务进度（不超过 target，已领取则忽略），变化后持久化 */
function addTaskProgress(taskId, amount) {
  let changed = false;
  for (const dt of dailyTaskState) {
    if (dt.task.id !== taskId || dt.claimed) continue;
    const data = window._lastShopData;
    const target = typeof dt.task.target === "function" ? dt.task.target(data?.realm || 1) : dt.task.target;
    if (dt.progress < target) {
      dt.progress = Math.min(target, dt.progress + amount);
      changed = true;
    }
  }
  if (changed) persistDailyTasks();
}

/** 比较新旧快照，把灵石/修为增量累计到对应任务 */
function trackDeltaTasks(data) {
  // 注意：ShopData 里灵石字段叫 savings（与存款共用）
  const stones = data.savings;
  if (lastStones !== null && stones > lastStones) {
    // 只统计"赚到的"灵石（不算花掉的），所以仅正向增量
    addTaskProgress("work_stones", Math.floor(stones - lastStones));
  }
  if (lastExp !== null && data.exp > lastExp) {
    addTaskProgress("idle_cultivate", data.exp - lastExp);
  }
  lastStones = stones;
  lastExp = data.exp;
}

function generateDailyTasks(realm) {
  // 从4个任务中选3个，保证至少1个"易完成"任务（work_stones/cast_spell）
  // pomodoro 最难（需持续专注5分钟），不保证出现
  const easy = DAILY_TASKS.filter(t => t.id === "work_stones" || t.id === "cast_spell");
  const hard = DAILY_TASKS.filter(t => t.id === "pomodoro" || t.id === "idle_cultivate");
  // 先从易任务里必选1个
  const mustEasy = easy[Math.floor(Math.random() * easy.length)];
  const selected = [{ task: mustEasy, progress: 0, claimed: false }];
  // 剩余从其他任务里随机选2个
  const pool = DAILY_TASKS.filter(t => t.id !== mustEasy.id);
  for (let i = 0; i < 2 && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    const task = pool.splice(idx, 1)[0];
    selected.push({ task, progress: 0, claimed: false });
  }
  return selected;
}

function renderTasks(data) {
  // 跨天检测：如果日期变了，重新生成（loadDailyTasks 是异步的，这里做同步兜底）
  if (dailyTaskDate && dailyTaskDate !== todayStr()) {
    dailyTaskState = generateDailyTasks(data.realm);
    dailyTaskDate = todayStr();
    persistDailyTasks();
  }
  if (!dailyTaskState || dailyTaskState.length === 0) {
    // 首次渲染时还没加载完，loadDailyTasks 在 refresh 里已调用
    return;
  }
  const container = document.getElementById("daily-tasks");
  container.innerHTML = "";
  for (const dt of dailyTaskState) {
    const target = typeof dt.task.target === "function" ? dt.task.target(data.realm) : dt.task.target;
    const done = dt.progress >= target;
    const desc = typeof dt.task.desc === "function" ? dt.task.desc(target) : dt.task.desc;
    let btnText, btnDisabled, iconText;
    if (dt.claimed) { btnText = "已领取"; btnDisabled = true; iconText = "✓"; }
    else if (done)  { btnText = "领取";   btnDisabled = false; iconText = "✓"; }
    else            { btnText = "未完成"; btnDisabled = true; iconText = "▶"; }
    const card = document.createElement("div");
    card.className = "item-card daily-task-card";
    card.innerHTML = `
      <div class="item-icon task-icon">${iconText}</div>
      <div class="item-info">
        <div class="item-name">${dt.task.name}</div>
        <div class="item-desc">${desc} <span class="task-progress">(${Math.min(dt.progress, target)}/${target})</span></div>
      </div>
      <div class="item-right">
        <div class="task-reward">◈${dt.task.reward_stones}</div>
        <button class="btn-claim" data-task="${dt.task.id}" ${btnDisabled ? "disabled" : ""}>${btnText}</button>
      </div>
    `;
    container.appendChild(card);
  }

  // 境界任务
  const realmTaskBtn = document.getElementById("btn-realm-task");
  const realmTaskName = document.getElementById("realm-task-name");
  const realmTaskDesc = document.getElementById("realm-task-desc");
  if (data.realm_task_done) {
    realmTaskBtn.textContent = "已完成";
    realmTaskBtn.disabled = true;
    realmTaskDesc.textContent = `突破成功率 +${data.task_bonus}%`;
  } else if (data.realm >= 6) {
    realmTaskBtn.textContent = "已飞升";
    realmTaskBtn.disabled = true;
  } else {
    realmTaskBtn.textContent = "接受";
    realmTaskBtn.disabled = false;
    realmTaskName.textContent = REALM_STORIES[data.realm]?.name || "试炼";
    realmTaskDesc.textContent = "完成剧情任务获得突破成功率加成";
  }
}

// ===== 境界剧情数据（扩充版：分支+隐藏选项+心魔联动）=====
// tier: 1=完美 2=普通 3=勉强（越小越好）
// condition: 函数，返回false则该选项隐藏（用于隐藏选项）
// demon: 正数表示该选项降低心魔值
// secret: 标记为隐藏选项（紫色样式）
const REALM_STORIES = {
  1: {
    name: "引气入体",
    scenes: [
      { text: "你盘膝而坐，感受天地间稀薄的灵气。远处传来一声叹息：「欲入修仙之门，先过心魔三问。」\n\n第一问：修仙为何？", choices: [
        { text: "为证大道，超脱凡俗", next: 1, tier: 1 },
        { text: "为求长生不老", next: 1, tier: 2 },
        { text: "不想打工了……打工太累了", next: 1, tier: 3 },
        { text: "「为护身边之人」——你想起屏幕角落那个陪你加班的小身影", next: 1, tier: 1, secret: true, demon: 10 },
      ]},
      { text: "第二问浮现于心：「若修炼途中，旧友凡人老去，你独活世间，当如何？」", choices: [
        { text: "大道无情，继续前行", next: 2, tier: 1 },
        { text: "陪伴他们走完一生", next: 2, tier: 2, demon: 5 },
        { text: "从未有过朋友", next: 2, tier: 3 },
      ]},
      { text: "第三问：「修仙路上九死一生，你可愿？」\n\n一道阴影从你心底浮起——那是你的心魔，它低语：「放弃吧，当个快乐的凡人不好吗？」", choices: [
        { text: "纵死无悔，斩灭心魔", next: 3, tier: 1, demon: 15 },
        { text: "尽力而为，驱散阴影", next: 3, tier: 2 },
        { text: "被心魔动摇，犹豫不决", next: 3, tier: 3 },
      ]},
      { text: "三问过后，一缕灵气涌入丹田。你的身体开始排出杂质——打工积累的疲惫、加班的暗伤、颈椎的酸痛，统统化为黑烟散去。\n\n灵气在经脉中流淌，第一层瓶颈近在眼前……", choices: [
        { text: "一鼓作气，冲破瓶颈", finish: true, tier: 1 },
        { text: "循序渐进，缓缓冲关", finish: true, tier: 2 },
        { text: "冲了半天才通", finish: true, tier: 3 },
      ]},
    ],
  },
  2: {
    name: "筑基大成",
    scenes: [
      { text: "练气圆满，筑基之劫降临。你的工位突然变成了幻阵——电脑屏幕变成一面镜子，镜中是一个不断加班、永不停歇的自己。\n\n心魔说：「我们本质一样。你就是个打工人，修什么仙？」", choices: [
        { text: "「我是修仙者，不是打工人！」挥剑斩之", next: 1, tier: 1, demon: 20 },
        { text: "「你说得对，但我不认命。」平静化解", next: 1, tier: 2, demon: 10 },
        { text: "被说动了，差点放弃修仙", next: 1, tier: 3 },
      ]},
      { text: "心魔化作黑烟，但并未完全消散。它在空气中低语：「我会回来的……每次你过劳、每次你突破失败，我都会变强。」\n\n这是对你的警告——心魔会随修仙之路不断积累。", choices: [
        { text: "「我已做好准备。」继续筑基", next: 2, tier: 1 },
        { text: "心中隐隐不安，但别无选择", next: 2, tier: 2 },
      ]},
      { text: "筑基需要引导灵力构建根基。你的丹田如同一座未完工的大厦地基，灵力是砖石，意志是图纸。\n\n一份加班报告突然飞到面前，甲方改了第18版需求。心魔趁机低语：「先做完工作吧，修仙不急。」", choices: [
        { text: "无视干扰，专注筑基", next: 3, tier: 1 },
        { text: "先处理工作，再继续筑基", next: 4, tier: 2 },
        { text: "被工作打断，筑基差点失败", next: 3, tier: 3 },
      ]},
      { text: "你选择了专注。灵力在意志引导下层层堆叠，筑基的根基越来越稳固。忽然，丹田中传来一声脆响——根基铸成！\n\n一道灵光冲天而起，周围的同事（如果有的话）都惊呆了。", choices: [
        { text: "趁势巩固，完美筑基", finish: true, tier: 1 },
        { text: "见好就收，稳固为主", finish: true, tier: 2 },
      ]},
      { text: "你先处理了工作，回来时灵力已经散乱。不得不重新聚气，从头开始筑基。\n\n心魔嘲笑道：「看吧，你终究是打工人。」", choices: [
        { text: "咬牙重来，最终成功", finish: true, tier: 2 },
        { text: "勉强筑基，根基不稳", finish: true, tier: 3 },
      ]},
    ],
  },
  3: {
    name: "金丹凝炼",
    scenes: [
      { text: "筑基大成，该凝金丹了。丹田中灵力旋转，渐成漩涡。一位老者的虚影浮现，竟是你们公司已经退休的创始元老。\n\n他说：「金丹之道，在于一心。心若不专，丹不成形。当年我创业时……算了不说这个。」", choices: [
        { text: "万念归一，专注凝丹", next: 1, tier: 1 },
        { text: "以身为炉，以心为火", next: 1, tier: 2 },
        { text: "边凝丹边刷手机", next: 1, tier: 3 },
      ]},
      { text: "金丹逐渐成形，你的意识沉入丹田。只见一颗金色的光球缓缓旋转，表面流转着符文。\n\n但金丹中央有一道裂纹——那是你积累的心魔侵蚀的痕迹。", choices: [
        { text: "以意志修补裂纹，完美金丹", next: 2, tier: 1, demon: 15 },
        { text: "裂纹不深，强行凝丹", next: 2, tier: 2 },
        { text: "不管了，先成型再说", next: 2, tier: 3 },
        { text: "（心魔已清者）金丹通体无瑕", next: 2, tier: 1, secret: true, condition: () => (window._lastShopData?.inner_demon || 0) < 30 },
      ]},
      { text: "金丹大成！但最后一关——丹劫降临。天空中凝聚出一道天雷，直劈你的金丹。\n\n这是天道的考验：金丹越纯粹，天雷越猛。", choices: [
        { text: "以金丹硬抗天劫，越挫越勇", finish: true, tier: 1 },
        { text: "借天雷之力淬炼金丹", finish: true, tier: 1, demon: 10 },
        { text: "闪避为主，保住金丹就行", finish: true, tier: 2 },
        { text: "差点被劈碎，金丹裂纹加深", finish: true, tier: 3 },
      ]},
    ],
  },
  4: {
    name: "元婴出窍",
    scenes: [
      { text: "金丹欲化元婴，需经历「化形之痛」。你的金丹在丹田中剧烈颤动，表面出现无数裂纹——它在孵化。\n\n终于，金丹碎裂，一个小人从中诞生。那是你的元婴——一个缩小版的你，穿着同样的道袍。", choices: [
        { text: "「你好，另一个我。」温和接纳", next: 1, tier: 1 },
        { text: "「我是你，你要听我的。」强势控制", next: 1, tier: 2 },
        { text: "「能不能让我再睡会儿……」元婴也在摸鱼", next: 1, tier: 3 },
      ]},
      { text: "元婴睁眼环顾四周，突然指着你的脑海说：「那里好黑，好多黑色的雾气在蠕动……好可怕。」\n\n它看到的是你的心魔。元婴与心魔共存于神识之中，心魔越多，元婴越不安。", choices: [
        { text: "「别怕，我来净化。」安抚元婴并化解心魔", next: 2, tier: 1, demon: 20 },
        { text: "「那不重要，先变强。」忽略心魔", next: 2, tier: 2 },
        { text: "「……我也怕。」与元婴一起畏惧", next: 2, tier: 3 },
      ]},
      { text: "元婴逐渐稳定，但还需要与肉身合一。这过程中，你会暂时失去所有感官——看不见、听不见、感受不到。\n\n你的手机响了。是工作群的消息：「@全体成员 紧急会议，现在上线。」", choices: [
        { text: "屏蔽一切，天人合一", next: 3, tier: 1 },
        { text: "犹豫了一下，还是继续融合", next: 3, tier: 2 },
        { text: "看了一眼手机，元婴差点跑掉", next: 3, tier: 3 },
        { text: "（已飞升坐骑者）元婴骑上坐骑，稳如泰山", next: 3, tier: 1, secret: true, condition: () => (window._lastShopData?.equipped_mount || 0) > 0 },
      ]},
      { text: "元婴与肉身完美融合！你感受到前所未有的清明——感官变得更加敏锐，灵力运转如臂使指。\n\n你的意识可以短暂脱离肉身，以元婴形态观察世界。第一次出窍时，你看到了……", choices: [
        { text: "看到了无数打工人头顶的疲惫之气", finish: true, tier: 1, demon: 10 },
        { text: "看到了灵脉的走向，天地之美", finish: true, tier: 1 },
        { text: "看到了甲方的前世（是一只蚊子）", finish: true, tier: 2 },
        { text: "什么都没看清就回来了", finish: true, tier: 3 },
      ]},
    ],
  },
  5: {
    name: "化神渡劫",
    scenes: [
      { text: "元婴圆满，化神在即。但化神劫是修仙路上最凶险的天劫——九道天雷接连劈下，一道比一道猛。\n\n天空中乌云翻涌，方圆百里灵气紊乱。你的手机收到天气预警：雷暴预警。", choices: [
        { text: "以身为引，主动迎雷（最险但最强）", next: 1, tier: 1 },
        { text: "布阵御雷，稳扎稳打", next: 1, tier: 2 },
        { text: "找个避雷针躲着……", next: 1, tier: 3 },
      ]},
      { text: "第一道至第三道天雷连劈而下！你的护体灵光被打得粉碎，道袍烧了一半。\n\n雷劫之间有短暂间歇，你听到心魔在狂笑：「哈！被打成这样还想化神？乖乖回去打工吧！」", choices: [
        { text: "「闭嘴！」怒斩心魔，以怒意抗雷", next: 2, tier: 1, demon: 25 },
        { text: "无视心魔，专注调息恢复", next: 2, tier: 2 },
        { text: "被心魔干扰，恢复变慢", next: 2, tier: 3 },
      ]},
      { text: "第四道至第六道天雷！这三道雷形成三角阵势，封锁了你的退路。\n\n你的坐骑（如果有）发出鸣叫，愿意替你分担雷劫——但代价是它会重伤。", choices: [
        { text: "独自抗下，不连累坐骑", next: 3, tier: 1 },
        { text: "接受坐骑的帮助，共同抗雷", next: 3, tier: 2 },
        { text: "没有坐骑，只能硬扛", next: 3, tier: 2, condition: () => (window._lastShopData?.equipped_mount || 0) === 0 },
      ]},
      { text: "第七道、第八道天雷劈下！你浑身焦黑，元婴在丹田中摇摇欲坠。但你还站着。\n\n最后一道——第九道天雷——正在云层中酝酿。这道雷不同于前八道，它是紫色的，带着毁灭一切的威压。", choices: [
        { text: "「我命由我不由天！」主动冲向天雷", next: 4, tier: 1 },
        { text: "以最后灵力布下防御", next: 4, tier: 2 },
        { text: "已经快撑不住了……", next: 4, tier: 3 },
      ]},
      { text: "第九道紫色天雷轰然落下！在它接触到你的一瞬间，时间仿佛静止。\n\n你的脑海中闪过整个修仙之路——从攒够500灵石的那个夜晚，到此刻立于雷劫之下。打工仔的身影、心魔的低语、元婴的微笑……\n\n你忽然明白了什么。", choices: [
        { text: "「打工是凡人的劫，修仙是我的道。」以悟道之力化解天雷", finish: true, tier: 1, demon: 30 },
        { text: "以毕生修为硬接天雷", finish: true, tier: 1 },
        { text: "勉强接下，重伤濒死", finish: true, tier: 2 },
        { text: "被天雷劈飞，差点元神俱灭", finish: true, tier: 3 },
      ]},
    ],
  },
  6: {
    name: "飞升之路",
    scenes: [
      { text: "化神圆满，飞升之门已开。天际出现一道金色裂缝，那是通往仙界的路。金光从裂缝中倾泻而下，照亮了你脚下的打工工位。\n\n飞升后，你将离开这个打工的世界，化为仙人。但你回头看了一眼——屏幕角落里，那个陪你一路走来的像素打工仔正安静地待着。", choices: [
        { text: "回头看了一眼，微笑道别", next: 1, tier: 1, demon: 20 },
        { text: "头也不回，踏入金光", next: 1, tier: 2 },
        { text: "犹豫了……真的要走吗？", next: 1, tier: 3 },
      ]},
      { text: "金光将你包裹。凡间的一切——加班报告、甲方需求、打卡记录——都在化为光点消散。\n\n在最后一刻，你听见打工仔说了一句话：「谢谢你带我修仙。以后……你自由了。」", choices: [
        { text: "「不，是你自由了。」踏入飞升之门", finish: true, tier: 1 },
        { text: "「再见，老伙计。」含泪飞升", finish: true, tier: 1, demon: 10 },
      ]},
    ],
  },
};

// ===== 剧情模式 =====
let storyState = null; // {realm, sceneIdx, tier}
const storyOverlay = document.getElementById("story-overlay");
const storyTitle = document.getElementById("story-title");
const storyText = document.getElementById("story-text");
const storyChoices = document.getElementById("story-choices");

function startRealmTask(realm) {
  const story = REALM_STORIES[realm];
  if (!story) return;
  storyState = { realm, sceneIdx: 0, tier: 3 };
  storyTitle.textContent = `${REALM_NAMES[realm]} · ${story.name}`;
  storyOverlay.hidden = false;
  renderStoryScene();
}

function renderStoryScene() {
  const story = REALM_STORIES[storyState.realm];
  const scene = story.scenes[storyState.sceneIdx];
  if (!scene) return;
  storyText.textContent = scene.text;
  storyChoices.innerHTML = "";
  for (const choice of scene.choices) {
    // 条件选项：condition 函数返回 false 则不显示（用于隐藏选项）
    if (choice.condition && !choice.condition()) continue;
    const btn = document.createElement("button");
    btn.className = "btn-story-choice";
    if (choice.secret) btn.classList.add("secret-choice");
    btn.textContent = choice.text;
    btn.addEventListener("click", () => {
      // 记录最好的 tier（数字越小越好）
      if (choice.tier < storyState.tier) storyState.tier = choice.tier;
      // 特殊效果：降低心魔（剧情里的"斩心魔"选项）
      if (choice.demon) storyState.demonReduce = (storyState.demonReduce || 0) + choice.demon;
      if (choice.finish) {
        finishRealmTask(storyState.tier, storyState.demonReduce || 0);
      } else {
        storyState.sceneIdx = choice.next;
        renderStoryScene();
      }
    });
    storyChoices.appendChild(btn);
  }
}

async function finishRealmTask(tier, demonReduce = 0) {
  try {
    await invoke("complete_realm_task", { tier, demonReduce });
    const tierName = tier === 1 ? "完美" : tier === 2 ? "普通" : "勉强";
    const bonus = tier === 1 ? 8 : tier === 2 ? 5 : 2;
    let msg = `${tierName}完成！突破成功率 +${bonus}%`;
    if (demonReduce > 0) msg += `，心魔 -${demonReduce}`;
    showToast(msg, "success");
  } catch (e) {
    showToast(String(e), "error");
  }
  storyOverlay.hidden = true;
  storyState = null;
  await refresh();
}

// 境界任务按钮
document.getElementById("btn-realm-task").addEventListener("click", () => {
  const data = window._lastShopData;
  if (data && data.cultivation_mode && !data.realm_task_done && data.realm < 6) {
    startRealmTask(data.realm);
  }
});

// 日常任务领取按钮（事件委托）
document.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-task]");
  if (!btn) return;
  if (btn.disabled) { showToast("任务未完成", "error"); return; }
  const taskId = btn.dataset.task;
  const dt = dailyTaskState.find((d) => d.task.id === taskId);
  if (!dt) { showToast("找不到任务: " + taskId, "error"); return; }
  if (dt.claimed) { showToast("已领取过", "error"); return; }
  const target = typeof dt.task.target === "function" ? dt.task.target(window._lastShopData?.realm || 1) : dt.task.target;
  if (dt.progress < target) {
    showToast(`进度不足: ${dt.progress}/${target}`, "error");
    return;
  }
  dt.claimed = true;
  persistDailyTasks();
  invoke("claim_daily_reward", { spiritStones: dt.task.reward_stones, exp: dt.task.reward_exp })
    .then(() => showToast(`领取 ${dt.task.reward_stones} 灵石！`, "success"))
    .catch((err) => { showToast(String(err), "error"); dt.claimed = false; persistDailyTasks(); })
    .finally(() => refresh());
});

// 启动
refresh();
