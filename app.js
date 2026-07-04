// ---- Configuration ----------------------------------------------------
// 1. Create an OAuth 2.0 Client ID (type: Web application) in Google Cloud Console.
// 2. Add your GitHub Pages origin (e.g. https://yourname.github.io) to
//    "Authorized JavaScript origins".
// 3. Paste the client ID below.
const CONFIG = {
  GOOGLE_CLIENT_ID: "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com",
  DRIVE_SCOPE: "https://www.googleapis.com/auth/drive.appdata",
  DRIVE_FILENAME: "ledger-data.json"
};

const EXPENSE_CATEGORIES = [
  { id: "food", label: "Food", color: "#C1533B" },
  { id: "transport", label: "Transport", color: "#4FA88B" },
  { id: "bills", label: "Bills", color: "#D9A441" },
  { id: "shopping", label: "Shopping", color: "#7C8FC9" },
  { id: "health", label: "Health", color: "#B06BC9" },
  { id: "other", label: "Other", color: "#8A8F92" }
];
const INCOME_CATEGORIES = [
  { id: "tips", label: "Tips", color: "#4FA88B" },
  { id: "salary", label: "Salary", color: "#7C8FC9" },
  { id: "bonus", label: "Bonus", color: "#D9A441" },
  { id: "other_income", label: "Other", color: "#8A8F92" }
];
const catMeta = (id) =>
  [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES].find((c) => c.id === id) || EXPENSE_CATEGORIES[5];

// ---- State --------------------------------------------------------------
// entries: { id, amount, type: 'expense'|'income', category, note, date }
let entries = JSON.parse(localStorage.getItem("ledger:entries") || "[]");
// migrate legacy entries (no type field) to expenses
entries = entries.map((e) => (e.type ? e : { ...e, type: "expense" }));
let view = "day";
let selectedType = "expense";
let selectedCategory = "food";
let tokenClient = null;
let accessToken = null;
let driveFileId = null;

const todayISO = () => new Date().toISOString().slice(0, 10);
const fmt = (n) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---- Persistence (local first, Drive as sync layer) ----------------------
function saveLocal() {
  localStorage.setItem("ledger:entries", JSON.stringify(entries));
}

let syncTimer = null;
function scheduleDriveSync() {
  if (!accessToken) return;
  setSyncStatus("syncing");
  clearTimeout(syncTimer);
  syncTimer = setTimeout(pushToDrive, 1200);
}

async function pushToDrive() {
  try {
    const body = JSON.stringify({ entries, updatedAt: new Date().toISOString() });
    if (!driveFileId) {
      driveFileId = await findOrCreateDriveFile();
    }
    await fetch(`https://www.googleapis.com/upload/drive/v3/files/${driveFileId}?uploadType=media`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body
    });
    setSyncStatus("connected");
  } catch (e) {
    console.error("Drive push failed", e);
    setSyncStatus("error");
  }
}

async function findOrCreateDriveFile() {
  const listRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name='${CONFIG.DRIVE_FILENAME}'&fields=files(id,name)`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const listData = await listRes.json();
  if (listData.files && listData.files.length > 0) return listData.files[0].id;

  const createRes = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "multipart/related; boundary=ledgerBoundary" },
    body:
      `--ledgerBoundary\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ name: CONFIG.DRIVE_FILENAME, parents: ["appDataFolder"] }) +
      `\r\n--ledgerBoundary\r\nContent-Type: application/json\r\n\r\n{}\r\n--ledgerBoundary--`
  });
  const created = await createRes.json();
  return created.id;
}

async function pullFromDrive() {
  try {
    if (!driveFileId) driveFileId = await findOrCreateDriveFile();
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data && Array.isArray(data.entries)) {
      // Merge by id, remote wins on conflict (simple last-write-wins per file version)
      const localIds = new Set(entries.map((e) => e.id));
      const merged = [...entries];
      data.entries.forEach((re) => {
        if (!localIds.has(re.id)) merged.push(re);
      });
      entries = merged;
      saveLocal();
      render();
    }
    setSyncStatus("connected");
  } catch (e) {
    console.error("Drive pull failed", e);
    setSyncStatus("error");
  }
}

// ---- Google auth ----------------------------------------------------------
function initGoogle() {
  if (typeof google === "undefined" || CONFIG.GOOGLE_CLIENT_ID.startsWith("YOUR_")) {
    setSyncStatus("unconfigured");
    return;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    scope: CONFIG.DRIVE_SCOPE,
    callback: (resp) => {
      if (resp.error) {
        setSyncStatus("error");
        return;
      }
      accessToken = resp.access_token;
      pullFromDrive();
    }
  });
}

function connectDrive() {
  if (!tokenClient) {
    alert("Add your Google OAuth Client ID in app.js first — see the comment at the top of the file.");
    return;
  }
  tokenClient.requestAccessToken();
}

function setSyncStatus(state) {
  const el = document.getElementById("syncStatus");
  el.className = "sync-status" + (state === "connected" ? " connected" : state === "syncing" ? " syncing" : "");
  const labels = {
    unconfigured: "Set up Drive sync",
    connected: "Synced to Drive",
    syncing: "Syncing…",
    error: "Sync error — tap to retry",
    disconnected: "Connect Google Drive"
  };
  el.querySelector(".label-text").textContent = labels[state] || labels.disconnected;
}

// ---- Derived data ----------------------------------------------------------
function sumByType(list) {
  const income = list.filter((e) => e.type === "income").reduce((s, e) => s + e.amount, 0);
  const expense = list.filter((e) => e.type !== "income").reduce((s, e) => s + e.amount, 0);
  return { income, expense, net: income - expense };
}

function last7Days() {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const { income, expense, net } = sumByType(entries.filter((e) => e.date === iso));
    days.push({ label: d.toLocaleDateString(undefined, { weekday: "short" }), iso, income, expense, net });
  }
  return days;
}

function last6Months() {
  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const list = entries.filter((e) => {
      const ed = new Date(e.date);
      return ed.getFullYear() === d.getFullYear() && ed.getMonth() === d.getMonth();
    });
    const { income, expense, net } = sumByType(list);
    months.push({ label: d.toLocaleDateString(undefined, { month: "short" }), income, expense, net });
  }
  return months;
}

function sumRange(startOffsetDays, endOffsetDays) {
  const list = [];
  for (let i = startOffsetDays; i >= endOffsetDays; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    entries.filter((e) => e.date === iso).forEach((e) => list.push(e));
  }
  return sumByType(list);
}

// ---- Chart (canvas, no deps) -----------------------------------------------
function roundedBar(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
  ctx.fill();
}

// data: [{ label, income, expense }]  — grouped income (green) vs expense (red) bars per period
function drawChart(data) {
  const canvas = document.getElementById("chart");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth,
    h = 140;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const max = Math.max(...data.map((d) => Math.max(d.income, d.expense)), 1);
  const groupW = w / data.length;
  const barW = groupW * 0.28;
  const baseline = h - 22;

  ctx.font = "11px 'IBM Plex Mono', monospace";
  ctx.textAlign = "center";

  data.forEach((d, i) => {
    const groupX = i * groupW;
    const expH = (d.expense / max) * 95;
    const incH = (d.income / max) * 95;
    const expX = groupX + groupW / 2 - barW - 2;
    const incX = groupX + groupW / 2 + 2;

    ctx.fillStyle = "#C1533B";
    roundedBar(ctx, expX, baseline - expH, barW, Math.max(expH, 1), 3);
    ctx.fillStyle = "#4FA88B";
    roundedBar(ctx, incX, baseline - incH, barW, Math.max(incH, 1), 3);

    ctx.fillStyle = "#8A8F92";
    ctx.fillText(d.label, groupX + groupW / 2, h - 6);
  });
}

// ---- Rendering ---------------------------------------------------------
function entriesForView() {
  if (view === "day") return entries.filter((e) => e.date === todayISO());
  if (view === "week") {
    const days = new Set(last7Days().map((d) => d.iso));
    return entries.filter((e) => days.has(e.date));
  }
  const now = new Date();
  return entries.filter((e) => {
    const ed = new Date(e.date);
    return ed.getFullYear() === now.getFullYear() && ed.getMonth() === now.getMonth();
  });
}

function render() {
  const todaySums = sumByType(entries.filter((e) => e.date === todayISO()));
  document.getElementById("todayTotal").textContent = (todaySums.net >= 0 ? "" : "-") + fmt(Math.abs(todaySums.net));
  document.getElementById("todayTotal").style.color = todaySums.net < 0 ? "#C1533B" : "#E9E6DE";
  document.getElementById("todaySub").textContent =
    `+${fmt(todaySums.income)} income · -${fmt(todaySums.expense)} spent`;
  document.getElementById("todayDate").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric"
  });

  const weekData = last7Days();
  const weekSums = weekData.reduce(
    (a, d) => ({ income: a.income + d.income, expense: a.expense + d.expense, net: a.net + d.net }),
    { income: 0, expense: 0, net: 0 }
  );
  fillCard("week", weekSums);

  const monthData = last6Months();
  const monthSums = monthData[monthData.length - 1];
  fillCard("month", monthSums);

  drawChart(view === "month" ? monthData : weekData);
  document.getElementById("chartLabel").textContent = view === "month" ? "Last 6 months" : "Last 7 days";

  renderChips();
  renderList();
}

function fillCard(prefix, sums) {
  document.getElementById(prefix + "Income").textContent = "+" + fmt(sums.income);
  document.getElementById(prefix + "Expense").textContent = "-" + fmt(sums.expense);
  const netEl = document.getElementById(prefix + "Net");
  netEl.textContent = (sums.net >= 0 ? "+" : "-") + fmt(Math.abs(sums.net));
  netEl.className = "value font-display " + (sums.net >= 0 ? "positive" : "negative");
}

function renderChips() {
  const source = entriesForView();
  const map = {};
  source.forEach((e) => {
    const key = e.category;
    if (!map[key]) map[key] = { total: 0, type: e.type };
    map[key].total += e.amount;
  });
  const list = Object.entries(map)
    .map(([id, v]) => ({ ...catMeta(id), ...v }))
    .sort((a, b) => b.total - a.total);

  const el = document.getElementById("chips");
  el.innerHTML = "";
  list.forEach((c) => {
    const chip = document.createElement("div");
    chip.className = "chip";
    const sign = c.type === "income" ? "+" : "-";
    chip.innerHTML = `<span class="swatch" style="background:${c.color}"></span><span>${c.label}</span><span class="amt">${sign}${fmt(c.total)}</span>`;
    el.appendChild(chip);
  });
}

function renderList() {
  const list = entriesForView().sort((a, b) => (a.date < b.date ? 1 : -1));
  const el = document.getElementById("receiptList");
  el.innerHTML = "";
  if (list.length === 0) {
    const label = view === "day" ? "today" : view === "week" ? "this week" : "this month";
    el.innerHTML = `<div class="empty">Nothing logged ${label} yet.</div>`;
    return;
  }
  list.forEach((e) => {
    const meta = catMeta(e.category);
    const row = document.createElement("div");
    row.className = "entry-row";
    const dateLabel = new Date(e.date).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const isIncome = e.type === "income";
    row.innerHTML = `
      <span class="entry-dot" style="background:${meta.color}"></span>
      <div class="entry-info">
        <div class="entry-note">${escapeHtml(e.note || meta.label)}</div>
        <div class="entry-meta">${meta.label} · ${dateLabel}</div>
      </div>
      <div class="leader"></div>
      <div class="entry-amt" style="color:${isIncome ? "#4FA88B" : "#E9E6DE"}">${isIncome ? "+" : "-"}${fmt(e.amount)}</div>
      <button class="entry-del" data-id="${e.id}" aria-label="Delete">✕</button>
    `;
    el.appendChild(row);
  });
  el.querySelectorAll(".entry-del").forEach((btn) => {
    btn.addEventListener("click", () => removeEntry(btn.dataset.id));
  });
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// ---- Actions ---------------------------------------------------------
function addEntry() {
  const amountInput = document.getElementById("amountInput");
  const noteInput = document.getElementById("noteInput");
  const dateInput = document.getElementById("dateInput");
  const amt = parseFloat(amountInput.value);
  const errorEl = document.getElementById("formError");

  if (!amt || amt <= 0) {
    errorEl.textContent = "Enter an amount greater than zero.";
    return;
  }
  errorEl.textContent = "";

  entries.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    amount: amt,
    type: selectedType,
    category: selectedCategory,
    note: noteInput.value.trim(),
    date: dateInput.value || todayISO()
  });
  saveLocal();
  scheduleDriveSync();
  closeSheet();
  amountInput.value = "";
  noteInput.value = "";
  dateInput.value = todayISO();
  render();
}

function removeEntry(id) {
  entries = entries.filter((e) => e.id !== id);
  saveLocal();
  scheduleDriveSync();
  render();
}

function openSheet() {
  document.getElementById("dateInput").value = todayISO();
  document.getElementById("sheetBackdrop").classList.remove("hidden");
}
function closeSheet() {
  document.getElementById("sheetBackdrop").classList.add("hidden");
}

// ---- Init ---------------------------------------------------------
function buildCategoryPicker() {
  const el = document.getElementById("catPicker");
  el.innerHTML = "";
  const list = selectedType === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  list.forEach((c) => {
    const btn = document.createElement("button");
    btn.className = "cat-btn" + (c.id === selectedCategory ? " selected" : "");
    btn.textContent = c.label;
    btn.style.background = c.id === selectedCategory ? c.color : "";
    btn.addEventListener("click", () => {
      selectedCategory = c.id;
      buildCategoryPicker();
    });
    el.appendChild(btn);
  });
}

function setEntryType(type) {
  selectedType = type;
  const list = type === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  selectedCategory = list[0].id;
  document.querySelectorAll(".type-tab").forEach((t) => t.classList.toggle("active", t.dataset.type === type));
  document.getElementById("saveEntry").textContent = type === "income" ? "Add income" : "Add expense";
  document.getElementById("saveEntry").style.background = type === "income" ? "#4FA88B" : "#D9A441";
  buildCategoryPicker();
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      view = tab.dataset.view;
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      render();
    });
  });
}

window.addEventListener("DOMContentLoaded", () => {
  buildCategoryPicker();
  setupTabs();
  document.querySelectorAll(".type-tab").forEach((t) => {
    t.addEventListener("click", () => setEntryType(t.dataset.type));
  });
  document.getElementById("addBtn").addEventListener("click", openSheet);
  document.getElementById("closeSheet").addEventListener("click", closeSheet);
  document.getElementById("sheetBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "sheetBackdrop") closeSheet();
  });
  document.getElementById("saveEntry").addEventListener("click", addEntry);
  document.getElementById("syncStatus").addEventListener("click", connectDrive);
  document.getElementById("dateInput").value = todayISO();
  document.getElementById("dateInput").max = todayISO();

  render();
  setSyncStatus("disconnected");

  // Google Identity Services script loads async; init once ready.
  const gisCheck = setInterval(() => {
    if (typeof google !== "undefined" && google.accounts) {
      clearInterval(gisCheck);
      initGoogle();
    }
  }, 300);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((e) => console.error("SW registration failed", e));
  }
});
