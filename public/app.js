const $ = (s) => document.querySelector(s);
const money = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const state = { rows: [], summary: null, filters: { source: "", q: "", status: "", category: "", bucket: "", from: "", to: "" } };

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => Number(v || 0);
const isSuccess = (r) => /^(completed|credit|success|succeeded|captured)$/i.test(String(r?.status || ""));
const webinarDate = "04-Jan-2026";
const isBundleUpsell = (r) => num(r.amount) === 99 && String(r.purpose || "").toLowerCase().includes("ultimate resource bundle");

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

function filterRows() {
  const f = state.filters;
  return state.rows.filter((r) => {
    if (f.source && r.source !== f.source) return false;
    if (f.q && !Object.values(r).join(" ").toLowerCase().includes(f.q)) return false;
    if (f.status && r.status !== f.status) return false;
    if (f.category && r.category !== f.category) return false;
    if (f.bucket && r.amount_bucket !== f.bucket) return false;
    if (f.from && r.created_at && new Date(r.created_at) < new Date(f.from)) return false;
    if (f.to && r.created_at && new Date(r.created_at) > new Date(`${f.to}T23:59:59.999Z`)) return false;
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

function applyOptions(id, values) {
  const el = $(id);
  const current = el.value;
  [...new Set(values)].filter(Boolean).sort().forEach((v) => {
    if ([...el.options].some((o) => o.value === v)) return;
    const opt = document.createElement("option");
    opt.value = v; opt.textContent = v; el.appendChild(opt);
  });
  el.value = current;
}

function applyWebinarOptions() {
  const el = $("#webinar");
  const current = el.value;
  const dates = webinarDates();
  el.innerHTML = `<option value="">All webinars</option>${dates.map((d) => `<option value="${d}">${d}</option>`).join("")}`;
  el.value = current && [...el.options].some((o) => o.value === current) ? current : (dates[0] || "");
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
  const total = rows.reduce((s, r) => s + num(r.amount), 0);
  const collected = rows.filter(isSuccess).reduce((s, r) => s + num(r.amount), 0);
  const completed = rows.filter(isSuccess).length;
  const pending = rows.filter((r) => /^(pending|initiated)$/i.test(r.status)).length;
  const split = (k) => rows.filter((r) => r.category === k);
  $("#providerLabel").textContent = "Combined";
  $("#kpis").innerHTML = [
    ["Transactions", rows.length],
    ["Collected", money.format(collected)],
    ["Requested", money.format(total)],
    ["Completed", `${completed} (${rows.length ? Math.round(completed / rows.length * 100) : 0}%)`],
    ["Webinar", `${split("Webinar").length} / ${money.format(split("Webinar").reduce((s, r) => s + num(r.amount), 0))}`],
    ["Bundle", `${split("Bundle").length} / ${money.format(split("Bundle").reduce((s, r) => s + num(r.amount), 0))}`],
    ["Course", `${split("Course").length} / ${money.format(split("Course").reduce((s, r) => s + num(r.amount), 0))}`],
    ["Pending", pending],
  ].map(([l, v]) => `<article class="kpi"><span>${l}</span><strong>${v}</strong></article>`).join("");
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
  chart([
    { label: "Webinar", value: split("Webinar").reduce((s, r) => s + num(r.amount), 0) },
    { label: "Bundle", value: split("Bundle").reduce((s, r) => s + num(r.amount), 0) },
    { label: "Course", value: split("Course").reduce((s, r) => s + num(r.amount), 0) },
    { label: "Other", value: rows.filter((r) => r.category === "Other").reduce((s, r) => s + num(r.amount), 0) },
  ].filter((x) => x.value > 0), "#categoryChart", "#74d6ff");
  chart(Object.entries(rows.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {})).map(([label, value]) => ({ label, value })), "#statusChart", "#8cffc3");
  $("#summaryLine").textContent = `Showing ${rows.length} of ${state.rows.length} transactions.`;
  $("#lastSync").textContent = state.summary?.generated_at ? new Date(state.summary.generated_at).toLocaleString() : "--";
  $("#table").innerHTML = rows.map((r) => `
    <tr>
      <td class="mono">${esc(r.transaction || "")}</td>
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

async function refreshData() {
  $("#refreshState").textContent = "Loading...";
  try {
    const [rows, summary] = await Promise.all([loadJson("./data/all/transactions.json"), loadJson("./data/all/summary.json")]);
    state.rows = rows;
    state.summary = summary;
    applyOptions("#source", state.rows.map((r) => r.source));
    applyOptions("#status", state.rows.map((r) => r.status));
    applyOptions("#category", state.rows.map((r) => r.category));
    applyOptions("#bucket", state.rows.map((r) => r.amount_bucket));
    applyWebinarOptions();
    const dates = state.rows.map((r) => r.created_at?.slice(0, 10)).filter(Boolean).sort();
    if (dates.length) {
      $("#from").min = dates[0];
      $("#to").max = dates[dates.length - 1];
    }
    render();
  } catch {
    $("#refreshState").textContent = "No combined data file yet. Run sync first.";
  }
}

["source","q","status","category","bucket","from","to","webinar"].forEach((id) => {
  const el = $(`#${id}`);
  const evt = id === "q" ? "input" : "change";
  el.addEventListener(evt, () => {
    if (id !== "webinar") state.filters[id] = id === "q" ? el.value.trim().toLowerCase() : el.value;
    render();
  });
});

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
