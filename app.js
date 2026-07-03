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

const CATEGORIES = [
  { id: "food", label: "Food", color: "#C1533B" },
  { id: "transport", label: "Transport", color: "#4FA88B" },
  { id: "bills", label: "Bills", color: "#D9A441" },
  { id: "shopping", label: "Shopping", color: "#7C8FC9" },
  { id: "health", label: "Health", color: "#B06BC9" },
  { id: "other", label: "Other", color: "#8A8F92" }
];
const catMeta = (id) => CATEGORIES.find((c) => c.id === id) || CATEGORIES[5];

// ---- State --------------------------------------------------------------
let entries = JSON.parse(localStorage.getItem("ledger:entries") || "[]");
let view = "day";
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
function last7Days() {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const total = entries.filter((e) => e.date === iso).reduce((s, e) => s + e.amount, 0);
    days.push({ label: d.toLocaleDateString(undefined, { weekday: "short" }), iso, total });
  }
  return days;
}

function last6Months() {
  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const total = entries
      .filter((e) => {
        const ed = new Date(e.date);
        return ed.getFullYear() === d.getFullYear() && ed.getMonth() === d.getMonth();
      })
      .reduce((s, e) => s + e.amount, 0);
    months.push({ label: d.toLocaleDateString(undefined, { month: "short" }), total });
  }
  return months;
}

function sumRange(startOffsetDays, endOffsetDays) {
  let sum = 0;
  for (let i = startOffsetDays; i >= endOffsetDays; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    sum += entries.filter((e) => e.date === iso).reduce((s, e) => s + e.amount, 0);
  }
  return sum;
}

// ---- Chart (canvas, no deps) -----------------------------------------------
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

  const max = Math.max(...data.map((d) => d.total), 1);
  const barW = (w / data.length) * 0.5;
  const gap = (w / data.length) * 0.5;

  ctx.font = "11px 'IBM Plex Mono', monospace";
  ctx.fillStyle = "#8A8F92";
  ctx.textAlign = "center";

  data.forEach((d, i) => {
    const x = i * (barW + gap) + gap / 2;
    const barH = (d.total / max) * 95;
    ctx.fillStyle = "#D9A441";
    ctx.beginPath();
    const r = 4;
    const y = h - 22 - barH;
    ctx.moveTo(x, h - 22);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.lineTo(x + barW - r, y);
    ctx.arcTo(x + barW, y, x + barW, y + r, r);
    ctx.lineTo(x + barW, h - 22);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#8A8F92";
    ctx.fillText(d.label, x + barW / 2, h - 6);
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
  const todayTotal = entries.filter((e) => e.date === todayISO()).reduce((s, e) => s + e.amount, 0);
  document.getElementById("todayTotal").textContent = fmt(todayTotal);
  document.getElementById("todayDate").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric"
  });

  const weekData = last7Days();
  const thisWeek = weekData.reduce((s, d) => s + d.total, 0);
  const lastWeek = sumRange(13, 7);
  document.getElementById("weekTotal").textContent = fmt(thisWeek);
  setDelta("weekDelta", lastWeek === 0 ? null : ((thisWeek - lastWeek) / lastWeek) * 100, "vs last week");

  const monthData = last6Months();
  const thisMonth = monthData[monthData.length - 1].total;
  const lastMonth = monthData[monthData.length - 2].total;
  document.getElementById("monthTotal").textContent = fmt(thisMonth);
  setDelta("monthDelta", lastMonth === 0 ? null : ((thisMonth - lastMonth) / lastMonth) * 100, "vs last month");

  drawChart(view === "month" ? monthData : weekData);
  document.getElementById("chartLabel").textContent = view === "month" ? "Last 6 months" : "Last 7 days";

  renderChips();
  renderList();
}

function setDelta(id, pct, suffix) {
  const el = document.getElementById(id);
  if (pct === null) {
    el.textContent = "";
    return;
  }
  el.className = "delta " + (pct > 0 ? "up" : "down");
  el.textContent = (pct > 0 ? "▲ " : "▼ ") + Math.abs(pct).toFixed(0) + "% " + suffix;
}

function renderChips() {
  const source = entriesForView();
  const map = {};
  source.forEach((e) => (map[e.category] = (map[e.category] || 0) + e.amount));
  const list = Object.entries(map)
    .map(([id, total]) => ({ ...catMeta(id), total }))
    .sort((a, b) => b.total - a.total);

  const el = document.getElementById("chips");
  el.innerHTML = "";
  list.forEach((c) => {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.innerHTML = `<span class="swatch" style="background:${c.color}"></span><span>${c.label}</span><span class="amt">${fmt(c.total)}</span>`;
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
    row.innerHTML = `
      <span class="entry-dot" style="background:${meta.color}"></span>
      <div class="entry-info">
        <div class="entry-note">${escapeHtml(e.note || meta.label)}</div>
        <div class="entry-meta">${meta.label} · ${dateLabel}</div>
      </div>
      <div class="leader"></div>
      <div class="entry-amt">${fmt(e.amount)}</div>
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
  CATEGORIES.forEach((c) => {
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
