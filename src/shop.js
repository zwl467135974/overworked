// 天工阁 —— 修仙商店前端
//
// 设计：修仙模式放开红线（数值全可见、游戏化 UI、主动提示）。
// 普通模式：只显示"开启修仙"按钮。
// 修仙模式：境界/修为/灵石/背包/道具全可见。

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// DOM
const numSavings = document.getElementById("num-savings");
const realmName = document.getElementById("realm-name");
const barExp = document.getElementById("bar-exp");
const expText = document.getElementById("exp-text");
const nextRealm = document.getElementById("next-realm");
const btnToggleMode = document.getElementById("btn-toggle-mode");
const modeHint = document.getElementById("mode-hint");
const shopSection = document.getElementById("shop-section");
const invSection = document.getElementById("inv-section");
const toast = document.getElementById("toast");
const priceBreakthrough = document.getElementById("price-breakthrough_pill");

// 当前状态缓存（按钮禁用判断用）
let currentData = null;

/** 渲染商店数据 */
function render(data) {
  currentData = data;
  // 灵石
  numSavings.textContent = Math.floor(data.savings);
  // 境界
  realmName.textContent = data.realm_name;
  // 修为条
  const pct = Math.max(0, Math.min(100, data.exp));
  barExp.style.width = pct + "%";
  expText.textContent = Math.floor(data.exp) + "/100";
  nextRealm.textContent = data.next_realm;
  // 突破丹价（随境界）
  if (priceBreakthrough) priceBreakthrough.textContent = data.breakthrough_price;
  // 背包
  document.getElementById("cnt-qi_pill").textContent = data.qi_pill;
  document.getElementById("cnt-life_pill").textContent = data.life_pill;
  document.getElementById("cnt-spirit_talisman").textContent = data.spirit_talisman;

  // 模式切换
  if (data.cultivation_mode) {
    btnToggleMode.textContent = "化凡（做回凡人）";
    btnToggleMode.classList.add("off");
    modeHint.textContent = "修仙模式：境界/修为/灵石全开。打工、专注、交付皆可积累修为。化凡后可随时重入，无需再花灵石。";
    shopSection.hidden = false;
    invSection.hidden = false;
    // 飞升后禁用突破
    if (data.realm >= 6) {
      const btn = document.querySelector('[data-item="breakthrough_pill"]');
      if (btn) {
        btn.disabled = true;
        btn.textContent = "已飞升";
      }
    }
  } else if (data.ever_cultivated) {
    // 曾修仙过（化凡状态）：重入免费
    btnToggleMode.textContent = "重入修仙（免费）";
    btnToggleMode.classList.remove("off");
    modeHint.textContent = "道基犹在，随时可重入修仙，无需再花灵石。";
    shopSection.hidden = true;
    invSection.hidden = true;
  } else {
    btnToggleMode.textContent = "开启修仙之路（500 灵石）";
    btnToggleMode.classList.remove("off");
    const enough = data.savings >= 500;
    modeHint.textContent = enough
      ? "灵石充足，踏入修仙。普通模式守规矩，修仙模式见真章。"
      : "还需 " + (500 - Math.floor(data.savings)) + " 灵石才能踏入修仙。继续打工攒钱吧。";
    shopSection.hidden = true;
    invSection.hidden = true;
  }

  // 按钮可用性：灵石不足则禁用
  document.querySelectorAll(".btn-buy").forEach((btn) => {
    if (btn.disabled) return; // 飞升的不动
    const item = btn.dataset.item;
    const price = item === "breakthrough_pill" ? data.breakthrough_price : ITEM_PRICE[item];
    btn.disabled = data.savings < price;
  });
}

const ITEM_PRICE = {
  qi_pill: 50,
  life_pill: 100,
  spirit_talisman: 200,
};

/** toast 提示 */
let toastTimer = null;
function showToast(msg, type = "") {
  toast.textContent = msg;
  toast.className = "toast show " + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.className = "toast " + type;
  }, 2200);
}

/** 拉取商店数据 */
async function refresh() {
  try {
    const data = await invoke("get_shop_data");
    render(data);
  } catch (e) {
    console.error("get_shop_data", e);
    showToast("数据读取失败", "error");
  }
}

/** 购买道具 */
async function buy(item) {
  try {
    await invoke("buy_item", { item });
    showToast("购买成功", "success");
  } catch (e) {
    showToast(String(e), "error");
  }
  // 无论成败都刷新（显示最新灵石）
  await refresh();
}

/** 切换修仙模式 */
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
document.querySelectorAll(".btn-buy").forEach((btn) => {
  btn.addEventListener("click", () => buy(btn.dataset.item));
});

// 监听后端推送的修仙面板更新（tick 实时刷新境界/修为/灵石）
listen("cultivation-update", () => {
  refresh();
});

// 监听四属性更新（普通模式下也每5秒推送，同步灵石=存款）
listen("stats-update", () => {
  refresh();
});

// 监听突破/走火入魔等事件，刷新并提示
listen("realm-up", (event) => {
  showToast("突破成功！", "success");
  refresh();
});
listen("cult-deviation", () => {
  showToast("走火入魔！修为清零", "error");
  refresh();
});
listen("cult-ascension", () => {
  showToast("恭喜飞升！", "success");
  refresh();
});

// 窗口被显示时刷新（从隐藏→显示）
listen("tauri://focus", () => refresh());

// 启动
refresh();
