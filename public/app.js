import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, collection, onSnapshot, doc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const firebaseConfig = {
  projectId: "instamojo-and-payu",
  appId: "1:804022659047:web:75aeeffeba26e4c6c73f42",
  storageBucket: "instamojo-and-payu.firebasestorage.app",
  apiKey: "AIzaSyB534BFLa3yqWxPaRvdioNRr-Om5nfBZeU",
  authDomain: "instamojo-and-payu.firebaseapp.com",
  messagingSenderId: "804022659047"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const $ = (s) => document.querySelector(s);
const money = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const filterFields = ["source", "category", "amount", "date", "day"];
const state = { rows: [], summary: null, filters: { q: "", source: [], category: [], amount: [], date: [], day: [], webinar: "" }, ui: { open: null, search: {} } };

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => Number(v || 0);
const isSuccess = (r) => /^(completed|credit|success|succeeded|captured)$/i.test(String(r?.status || ""));
const webinarDate = "04-Jan-2026";
const isBundleUpsell = (r) => num(r.amount) === 99 && String(r.purpose || r.source_purpose || "").toLowerCase().includes("ultimate resource bundle");

function parseDmy(date) {
  const m = String(date || "").match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  return { y: +m[3], m: months[m[2]], d: +m[1] };
}

function timeToMinutes(t) {
  const m = String(t || "").trim().match(/^(\d{1,2}):(\d{2})\s*([ap]m)$/i);
  if (!m) return null;
  let h = Number(m[1]), min = Number(m[2]);
  const ap = m[3].toLowerCase();
  if (ap === "pm" && h !== 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return h * 60 + min;
}

function istTs(date, mins) {
  const p = parseDmy(date);
  if (!p) return null;
  return Date.UTC(p.y, p.m, p.d, 0, mins - 330);
}

function toIstTs(date, time) {
  const mins = timeToMinutes(time);
  if (mins === null) return istTs(date, 0);
  return istTs(date, mins);
}

function shiftDate(date, days) {
  const p = parseDmy(date);
  if (!p) return null;
  const d = new Date(Date.UTC(p.y, p.m, p.d));
  d.setUTCDate(d.getUTCDate() + days);
  return `${String(d.getUTCDate()).padStart(2, "0")}-${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

function webinarDates() {
  return [...new Set(state.rows.filter((r) => r.day === "Sunday" || r.date === webinarDate).map((r) => r.date))].sort((a, b) => new Date(b.split("-").reverse().join("-")) - new Date(a.split("-").reverse().join("-")));
}

function weekWindow(date) {
  const prev = shiftDate(date, -7);
  if (!prev) return [null, null];
  return [istTs(prev, 17 * 60 + 30), istTs(date, 17 * 60 + 30)];
}

function liveWindow(date) {
  if (!parseDmy(date)) return [null, null];
  if (date === webinarDate) return [istTs(date, 0), istTs(date, 23 * 60 + 59)];
  return [istTs(date, 19 * 60), istTs(date, 23 * 60 + 45)];
}

function webinarStats(date) {
  const [wStart, wEnd] = weekWindow(date);
  const [lStart, lEnd] = liveWindow(date);
  const registrations = state.rows.filter((r) => {
    const ts = toIstTs(r.date, r.time);
    return ts !== null && ts >= wStart && ts < wEnd && !isBundleUpsell(r) && (num(r.amount) === 99 || num(r.amount) === 198);
  }).length;
  const bundles = state.rows.filter((r) => {
    const ts = toIstTs(r.date, r.time);
    return ts !== null && ts >= wStart && ts < wEnd && (num(r.amount) === 198 || isBundleUpsell(r));
  }).length;
  const courses = state.rows.filter((r) => {
    const ts = toIstTs(r.date, r.time);
    return ts !== null && ts >= lStart && ts <= lEnd && num(r.amount) > 500;
  }).length;
  return {
    registrations,
    bundles,
    courses,
    bundleConv: registrations ? bundles / registrations : 0,
    courseConv: registrations ? courses / registrations : 0,
  };
}

function historicalStats() {
  return webinarDates().reduce((acc, date) => {
    const s = webinarStats(date);
    acc.registrations += s.registrations;
    acc.bundles += s.bundles;
    acc.courses += s.courses;
    return acc;
  }, { registrations: 0, bundles: 0, courses: 0 });
}

function metricCard(label, value) {
  return `<article class="kpi"><span>${label}</span><strong>${value}</strong></article>`;
}

function pct(v) {
  return `${(v * 100).toFixed(1).replace(/\.0$/, "")}%`;
}

async function loadJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(url);
  return res.json();
}

const rowText = (r) => [r.transaction, r.name, r.phone, r.email, r.source, r.category, r.amount, r.date, r.day, r.time, r.request_id, r.status, r.amount_bucket, r.purpose, r.source_purpose].join(" ").toLowerCase();
const uniq = (v) => [...new Set(v.filter((x) => x !== "" && x !== null && x !== undefined).map((x) => String(x)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

function filterRows() {
  const f = state.filters;
  return state.rows.filter((r) => {
    if (f.q && !rowText(r).includes(f.q)) return false;
    if (f.source.length && !f.source.includes(String(r.source || ""))) return false;
    if (f.category.length && !f.category.includes(String(r.category || ""))) return false;
    if (f.amount.length && !f.amount.includes(String(r.amount || ""))) return false;
    if (f.date.length && !f.date.includes(String(r.date || ""))) return false;
    if (f.day.length && !f.day.includes(String(r.day || ""))) return false;
    return true;
  });
}

function chart(items, id, color) {
  const w = 520, h = 220, pad = 26, barW = Math.max(28, (w - pad * 2) / Math.max(1, items.length) - 10);
  const max = Math.max(...items.map((x) => x.value), 1);
  $(id).innerHTML = `<svg viewBox="0 0 ${w} ${h}" class="svg">${items.map((x, i) => {
    const bh = ((h - pad * 2 - 28) * x.value) / max;
    const x0 = pad + i * (barW + 10);
    return `<g><rect x="${x0}" y="${h - pad - bh - 18}" width="${barW}" height="${bh}" rx="12" fill="${color}"/><text x="${x0 + barW / 2}" y="${h - 8}" text-anchor="middle" fill="#9db0d0" font-size="11">${esc(x.label)}</text><text x="${x0 + barW / 2}" y="${h - pad - bh - 28}" text-anchor="middle" fill="#eaf2ff" font-size="11" font-weight="700">${x.value}</text></g>`;
  }).join("")}</svg>`;
}

function applyWebinarOptions() {
  const el = $("#webinar");
  const current = el.value;
  const dates = webinarDates();
  el.innerHTML = `<option value="">All webinars</option>${dates.map((d) => `<option value="${d}">${d}</option>`).join("")}`;
  el.value = current && [...el.options].some((o) => o.value === current) ? current : (dates[0] || "");
}

function filterOptions(field) {
  const q = (state.ui.search[field] || "").trim().toLowerCase();
  return uniq(state.rows.map((r) => String(r[field] || ""))).filter((v) => !q || v.toLowerCase().includes(q));
}

function setFilter(field, values) {
  state.filters[field] = [...new Set(values.map(String))];
  render();
}

function toggleFilter(field, value) {
  const cur = state.filters[field];
  setFilter(field, cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]);
}

function clearFilter(field) {
  state.filters[field] = [];
  state.ui.search[field] = "";
  render();
}

function filterBadge(field) {
  const cur = state.filters[field];
  return cur.length ? `${cur.length} selected` : "All";
}

function menuHTML(field) {
  const cap = field[0].toUpperCase() + field.slice(1);
  const options = filterOptions(field);
  const items = options.map((v) => {
    const checked = state.filters[field].includes(v) ? "checked" : "";
    return `<label class="filter-option"><input type="checkbox" data-field="${field}" data-value="${esc(v)}" ${checked}><span>${esc(v)}</span></label>`;
  }).join("") || `<div class="empty small">No matches</div>`;
  return `
    <div class="filter-menu">
      <input class="filter-search" data-search="${field}" placeholder="Search ${cap.toLowerCase()}" value="${esc(state.ui.search[field] || "")}">
      <div class="filter-menu-actions">
        <button type="button" class="ghost" data-action="select-all" data-field="${field}">Select all</button>
        <button type="button" class="ghost" data-action="clear" data-field="${field}">Clear</button>
      </div>
      <div class="filter-options">${items}</div>
    </div>`;
}

function renderFilterWidgets() {
  const wrap = $("#filterWidgets");
  if (!wrap) return;
  wrap.innerHTML = filterFields.map((field) => `
    <div class="filter-widget">
      <button type="button" class="filter-trigger" data-action="toggle" data-field="${field}" data-filter-button="${field}">
        <span>${field[0].toUpperCase() + field.slice(1)}</span>
        <strong>${filterBadge(field)}</strong>
      </button>
    </div>
  `).join("");
}

function portal() {
  let el = $("#filterPortal");
  if (!el) {
    el = document.createElement("div");
    el.id = "filterPortal";
    el.className = "filter-portal";
    document.body.appendChild(el);
  }
  return el;
}

function updateFilterPortalOptions(field) {
  const p = portal();
  const box = p.querySelector(".filter-options");
  if (!box) return;
  const options = filterOptions(field);
  box.innerHTML = options.map((v) => {
    const checked = state.filters[field].includes(v) ? "checked" : "";
    return `<label class="filter-option"><input type="checkbox" data-field="${field}" data-value="${esc(v)}" ${checked}><span>${esc(v)}</span></label>`;
  }).join("") || `<div class="empty small">No matches</div>`;
}

function positionFilterPortal(focus = false) {
  const field = state.ui.open;
  const p = portal();
  if (!field) { p.innerHTML = ""; p.hidden = true; return; }
  const btn = document.querySelector(`[data-filter-button="${field}"]`);
  if (!btn) return;
  const r = btn.getBoundingClientRect();
  p.hidden = false;
  p.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 20)}px`;
  p.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - Math.max(260, r.width) - 8))}px`;
  p.style.width = `${Math.max(260, r.width)}px`;
  p.innerHTML = menuHTML(field);
  if (focus) requestAnimationFrame(() => p.querySelector(`[data-search="${field}"]`)?.focus());
}

function csv(rows) {
  const cols = ["transaction","name","phone","email","source","category","amount","date","day","time","request_id","status","amount_bucket","purpose","bank_name","mode","bank_ref_num","payment_gateway","created_at","updated_at","longurl","shorturl","redirect_url","webhook","instrument_type","action","error_code","source_txn_status"];
  const q = (v, c) => {
    let s = String(v ?? "");
    if (c === "phone" && s) s = `\t${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => q(r[c], c)).join(","))].join("\n");
}

function download(name, text, type = "text/plain") {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function render() {
  const rows = filterRows();
  const selectedWebinar = $("#webinar")?.value || "";
  const selectedStats = selectedWebinar ? webinarStats(selectedWebinar) : { registrations: 0, bundles: 0, courses: 0, bundleConv: 0, courseConv: 0 };
  const history = historicalStats();
  $("#providerLabel").textContent = "Combined";
  $("#webinarKpis").innerHTML = [
    metricCard("Registrations", selectedStats.registrations),
    metricCard("Bundle buyers", selectedStats.bundles),
    metricCard("Course buyers", selectedStats.courses),
    metricCard("Bundle conversion", pct(selectedStats.bundleConv)),
    metricCard("Course conversion", pct(selectedStats.courseConv)),
  ].join("");
  $("#historyKpis").innerHTML = [
    metricCard("Registrations", history.registrations),
    metricCard("Bundle buyers", history.bundles),
    metricCard("Course buyers", history.courses),
    metricCard("Bundle conversion", pct(history.registrations ? history.bundles / history.registrations : 0)),
    metricCard("Course conversion", pct(history.registrations ? history.courses / history.registrations : 0)),
  ].join("");
  $("#lastSync").textContent = state.summary?.generated_at ? new Date(state.summary.generated_at).toLocaleString() : "--";
  renderFilterWidgets();
  positionFilterPortal();
  $("#table").innerHTML = rows.map((r) => `
    <tr>
      <td><strong>${esc(r.name || "")}</strong></td>
      <td>${esc(r.phone || "")}</td>
      <td>${esc(r.email || "")}</td>
      <td><span class="tag ${esc(String(r.source || "other").toLowerCase())}">${esc(r.source)}</span></td>
      <td><span class="tag ${esc(String(r.category || "other").toLowerCase())}">${esc(r.category)}</span></td>
      <td class="amount">${num(r.amount)}</td>
      <td>${esc(r.date || "")}</td>
      <td>${esc(r.day || "")}</td>
      <td>${esc(r.time || "")}</td>
    </tr>`).join("") || `<tr><td colspan="10" class="empty">No matching payments</td></tr>`;
  $("#refreshState").textContent = state.summary?.generated_at ? `Updated ${new Date(state.summary.generated_at).toLocaleString()}` : "Loaded";
}

let unsubRows = null;
let unsubMeta = null;

function refreshData() {
  $("#refreshState").textContent = "Connecting to Firestore...";
  
  if (unsubRows) {
    try { unsubRows(); } catch {}
  }
  if (unsubMeta) {
    try { unsubMeta(); } catch {}
  }
  
  unsubMeta = onSnapshot(doc(db, "meta", "payments"), (docSnap) => {
    if (docSnap.exists()) {
      const data = docSnap.data();
      state.summary = {
        ...data,
        generated_at: data.generated_at || (data.updated_at ? data.updated_at.toDate().toISOString() : new Date().toISOString())
      };
      render();
    }
  }, (err) => {
    console.error("Meta summary subscription failed:", err);
  });
  
  unsubRows = onSnapshot(collection(db, "payments"), (snapshot) => {
    const rows = [];
    snapshot.forEach((d) => {
      rows.push(d.data());
    });
    state.rows = sortRows(rows);
    applyWebinarOptions();
    render();
    $("#refreshState").textContent = state.summary?.generated_at 
      ? `Updated ${new Date(state.summary.generated_at).toLocaleString()}` 
      : "Loaded";
  }, (err) => {
    console.error("Payments subscription failed:", err);
    $("#refreshState").textContent = "Failed to load from Firestore.";
  });
}

$("#q").addEventListener("input", (e) => { state.filters.q = e.target.value.trim().toLowerCase(); render(); });
$("#webinar").addEventListener("change", (e) => { state.filters.webinar = e.target.value; render(); });
$("#clearFilters").addEventListener("click", () => {
  state.filters = { q: "", source: [], category: [], amount: [], date: [], day: [], webinar: $("#webinar").value };
  state.ui.search = {};
  $("#q").value = "";
  render();
});

$("#filterWidgets").addEventListener("click", (e) => {
  const a = e.target.closest("[data-action]");
  if (!a) return;
  const field = a.dataset.field;
  const action = a.dataset.action;
  if (action === "toggle") {
    state.ui.open = state.ui.open === field ? null : field;
    positionFilterPortal(true);
    return;
  }
});

portal().addEventListener("click", (e) => {
  const a = e.target.closest("[data-action]");
  if (!a) return;
  const field = a.dataset.field;
  const action = a.dataset.action;
  if (action === "select-all") {
    setFilter(field, filterOptions(field));
    state.ui.open = field;
    positionFilterPortal(false);
    return;
  }
  if (action === "clear") {
    clearFilter(field);
    state.ui.open = field;
    positionFilterPortal(false);
  }
});

portal().addEventListener("input", (e) => {
  const input = e.target.closest("[data-search]");
  if (!input) return;
  state.ui.search[input.dataset.search] = input.value;
  updateFilterPortalOptions(input.dataset.search);
});

portal().addEventListener("change", (e) => {
  const cb = e.target.closest('input[type="checkbox"][data-field][data-value]');
  if (!cb) return;
  toggleFilter(cb.dataset.field, cb.dataset.value);
});

document.addEventListener("click", (e) => {
  if (!e.target.closest("#filterPortal") && !e.target.closest("#filterWidgets")) {
    state.ui.open = null;
    positionFilterPortal();
  }
});
window.addEventListener("resize", positionFilterPortal);
window.addEventListener("scroll", positionFilterPortal, true);

$("#exportAll").addEventListener("click", () => {
  if (!state.rows.length) return;
  download("all-transactions.csv", csv(state.rows), "text/csv");
});
$("#reload").addEventListener("click", refreshData);
$("#serverRefresh").addEventListener("click", async () => {
  try {
    const res = await fetch("/api/refresh?provider=all", { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    await refreshData();
  } catch {
    $("#refreshState").textContent = "Server refresh unavailable here.";
  }
});

refreshData();
