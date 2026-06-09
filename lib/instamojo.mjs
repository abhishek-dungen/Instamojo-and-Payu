import fs from "node:fs";

export function loadEnvFiles(files = ["safe.env", ".env.local"]) {
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
}

export const money = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

export function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d;
  const s = String(value).trim();
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m) {
    const d2 = new Date(`${m[1]} ${m[2]} ${m[3]} 00:00:00`);
    if (!Number.isNaN(d2.getTime())) return d2;
  }
  return null;
}

export function classifyAmount(amount) {
  if (amount === 99) return "Webinar";
  if (amount === 198) return "Bundle";
  if (amount > 500) return "Course";
  return "Other";
}

export function normalizePayment(raw = {}, fallback = {}) {
  const pick = (keys) => {
    for (const k of keys) {
      const v = raw?.[k] ?? fallback?.[k];
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return "";
  };
  const amount = Number(pick(["amount", "total_amount"]) || 0);
  const createdAt = pick(["created_at", "created", "date", "payment_date", "payment_time", "payment_created_at"]);
  const updatedAt = pick(["modified_at", "updated_at", "modified", "payment_updated_at"]);
  const created = parseDate(createdAt);
  const updated = parseDate(updatedAt);
  const id = String(pick(["payment_id", "id", "transaction", "payment", "request_id"]) || globalThis.crypto?.randomUUID?.() || `${Date.now()}`);
  return {
    transaction: id,
    request_id: String(pick(["payment_request_id", "request_id"]) || ""),
    status: String(pick(["status"]) || "Unknown"),
    amount,
    category: classifyAmount(amount),
    amount_bucket: amount === 99 ? "99" : amount === 198 ? "198" : amount > 500 ? "500+" : "Other",
    source: "Instamojo",
    name: String(pick(["buyer_name", "name", "buyer"]) || ""),
    phone: String(pick(["buyer_phone", "phone"]) || ""),
    email: String(pick(["email", "buyer_email"]) || ""),
    purpose: String(pick(["purpose", "description"]) || ""),
    longurl: String(pick(["longurl"]) || ""),
    shorturl: String(pick(["shorturl"]) || ""),
    redirect_url: String(pick(["redirect_url"]) || ""),
    webhook: String(pick(["webhook"]) || ""),
    instrument_type: String(pick(["instrument_type"]) || ""),
    created_at: created ? created.toISOString() : String(createdAt || ""),
    updated_at: updated ? updated.toISOString() : String(updatedAt || ""),
    date: created ? created.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).replace(/ /g, "-") : String(createdAt || ""),
    day: created ? new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(created) : "",
    time: created ? created.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase() : "",
  };
}

export function sortRows(rows) {
  return [...rows].sort((a, b) => {
    const ta = Date.parse(a.created_at || a.updated_at || 0) || 0;
    const tb = Date.parse(b.created_at || b.updated_at || 0) || 0;
    if (tb !== ta) return tb - ta;
    return Number(b.amount || 0) - Number(a.amount || 0);
  });
}

export function readCsvPayments(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text) return [];
  const rows = [];
  let cur = "";
  let row = [];
  let q = false;
  const push = () => { row.push(cur); cur = ""; };
  const flush = () => { if (row.length) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (q) {
      if (c === '"' && n === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") push();
    else if (c === "\n") { push(); flush(); }
    else if (c !== "\r") cur += c;
  }
  push(); flush();
  const [head, ...data] = rows;
  if (!head) return [];
  return data.filter((r) => r.length).map((r) => {
    const o = {};
    head.forEach((k, i) => { o[k] = r[i] ?? ""; });
    return normalizePayment(o, o);
  });
}

export function summarize(rows = []) {
  const totals = {
    count: rows.length,
    collected: 0,
    requested: 0,
    completed: 0,
    pending: 0,
    failed: 0,
    webinarCount: 0,
    bundleCount: 0,
    courseCount: 0,
    otherCount: 0,
    webinarAmount: 0,
    bundleAmount: 0,
    courseAmount: 0,
    otherAmount: 0,
  };
  const byStatus = new Map();
  const byCategory = new Map();
  const byDate = new Map();
  for (const row of rows) {
    const amount = Number(row.amount || 0);
    totals.requested += amount;
    const status = String(row.status || "Unknown");
    const cat = String(row.category || "Other");
    byStatus.set(status, (byStatus.get(status) || 0) + 1);
    byCategory.set(cat, (byCategory.get(cat) || 0) + 1);
    if (row.date) byDate.set(row.date, (byDate.get(row.date) || 0) + amount);
    if (status.toLowerCase() === "completed" || status.toLowerCase() === "credit" || status.toLowerCase() === "success") {
      totals.completed += 1;
      totals.collected += amount;
    } else if (status.toLowerCase() === "pending" || status.toLowerCase() === "initiated") {
      totals.pending += 1;
    } else if (status.toLowerCase() === "failed" || status.toLowerCase() === "failure") {
      totals.failed += 1;
    }
    if (cat === "Webinar") {
      totals.webinarCount += 1; totals.webinarAmount += amount;
    } else if (cat === "Bundle") {
      totals.bundleCount += 1; totals.bundleAmount += amount;
    } else if (cat === "Course") {
      totals.courseCount += 1; totals.courseAmount += amount;
    } else {
      totals.otherCount += 1; totals.otherAmount += amount;
    }
  }
  const avg = rows.length ? totals.requested / rows.length : 0;
  const peak = [...byDate.entries()].sort((a, b) => b[1] - a[1])[0] || ["", 0];
  return {
    totals: {
      ...totals,
      avgTicket: avg,
      completionRate: rows.length ? totals.completed / rows.length : 0,
    },
    byStatus: [...byStatus.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value),
    byCategory: [...byCategory.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value),
    byDate: [...byDate.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => new Date(a.label) - new Date(b.label)),
    peakDay: { label: peak[0], value: peak[1] },
  };
}

export function toCsv(rows = []) {
  const cols = ["transaction","request_id","status","amount","category","amount_bucket","name","phone","email","purpose","source","instrument_type","date","day","time","created_at","updated_at","longurl","shorturl","redirect_url","webhook"];
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

export function pickVisibleRows(rows, filters = {}) {
  const q = String(filters.q || "").trim().toLowerCase();
  return rows.filter((r) => {
    if (q) {
      const hay = Object.values(r).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (filters.status && r.status !== filters.status) return false;
    if (filters.category && r.category !== filters.category) return false;
    if (filters.amount_bucket && r.amount_bucket !== filters.amount_bucket) return false;
    if (filters.from && r.created_at && new Date(r.created_at) < new Date(filters.from)) return false;
    if (filters.to && r.created_at && new Date(r.created_at) > new Date(filters.to + "T23:59:59.999Z")) return false;
    return true;
  });
}
