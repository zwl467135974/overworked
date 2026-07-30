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
  { key: "fireball", name: "火球术", icon: "火", price: 300, desc: "红橙火球爆裂" },
  { key: "ice", name: "冰封术", icon: "冰", price: 600, desc: "蓝白冰晶绽放" },
  { key: "thunder", name: "雷劫术", icon: "雷", price: 1200, desc: "紫白闪电劈下" },
  { key: "swords", name: "万剑诀", icon: "剑", price: 3000, desc: "数十光剑天降" },
  { key: "armageddon", name: "天地同寿", icon: "灭", price: 8000, desc: "五色光柱冲天" },
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
const toast = document.getElementById("toast");
const priceBreakthrough = document.getElementById("price-breakthrough_pill");
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

/** 渲染法术列表 */
function renderSpells(data) {
  spellList.innerHTML = "";
  for (const s of SPELLS) {
    const count = data.spells[SPELLS.indexOf(s)];
    const card = document.createElement("div");
    card.className = "item-card";
    card.innerHTML = `
      <div class="item-icon spell-icon">${s.icon}</div>
      <div class="item-info">
        <div class="item-name">${s.name} ${count > 0 ? `<span class="stock-tag">×${count}</span>` : ""}</div>
        <div class="item-desc">${s.desc}</div>
      </div>
      <div class="item-right">
        <div class="item-price">${s.price}</div>
        <div class="btn-group">
          <button class="btn-buy" data-item="${s.key}" ${data.savings < s.price ? "disabled" : ""}>购买</button>
          ${count > 0 ? `<button class="btn-cast" data-spell="${s.key}">施展</button>` : ""}
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
    renderMounts(data);
    renderSpells(data);
    if (data.realm >= 6) {
      const btn = document.querySelector('[data-item="breakthrough_pill"]');
      if (btn) { btn.disabled = true; btn.textContent = "已飞升"; }
    }
  } else if (data.ever_cultivated) {
    btnToggleMode.textContent = "重入修仙（免费）";
    btnToggleMode.classList.remove("off");
    modeHint.textContent = "道基犹在，随时可重入修仙，无需再花灵石。";
    shopSection.hidden = true;
    mountSection.hidden = true;
    spellSection.hidden = true;
    invSection.hidden = true;
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
    render(data);
  } catch (e) {
    console.error("get_shop_data", e);
    showToast("数据读取失败", "error");
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
listen("spell-cast", () => refresh());
listen("tauri://focus", () => refresh());

refresh();
