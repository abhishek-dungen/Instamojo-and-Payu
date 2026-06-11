import fs from "node:fs";
import path from "node:path";

export function loadEnvFiles(files = [".env", "safe.env", ".env.local"]) {
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
}

async function fetchJson(url, init) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20000);
  const res = await fetch(url, { ...init, signal: ac.signal }).finally(() => clearTimeout(t));
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return { json: await res.json(), headers: res.headers };
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

export function isBundleUpsellPurpose(purpose = "") {
  return String(purpose || "").toLowerCase().includes("ultimate resource bundle");
}

export function classifyAmount(amount, purpose = "") {
  if (amount === 99 && isBundleUpsellPurpose(purpose)) return "Bundle";
  if (amount === 99) return "Webinar";
  if (amount === 198) return "Bundle";
  if (amount > 500) return "Course";
  return "Other";
}

export function isSuccessfulPayment(row = {}) {
  if (row.status === true) return true;
  if (row.status === false || row.status === null || row.status === undefined) return false;
  const s = String(row.status || "").trim().toLowerCase();
  return s === "completed" || s === "credit" || s === "success" || s === "succeeded" || s === "captured";
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
  const sourcePurpose = String(pick(["purpose", "title", "description"]) || "");
  const created = parseDate(createdAt);
  const updated = parseDate(updatedAt);
  const id = String(pick(["payment_id", "id", "transaction", "payment", "request_id"]) || globalThis.crypto?.randomUUID?.() || `${Date.now()}`);
  return finalizeInstamojoRow({
    transaction: id,
    request_id: String(pick(["payment_request_id", "request_id"]) || ""),
    status: String(pick(["status"]) || "Unknown"),
    amount,
    category: classifyAmount(amount, sourcePurpose),
    amount_bucket: amount === 99 ? "99" : amount === 198 ? "198" : amount > 500 ? "500+" : "Other",
    source: "Instamojo",
    provider: "Instamojo",
    name: String(pick(["buyer_name", "name", "buyer"]) || ""),
    phone: String(pick(["buyer_phone", "phone"]) || ""),
    email: String(pick(["email", "buyer_email"]) || ""),
    purpose: sourcePurpose,
    source_purpose: sourcePurpose,
    bank_name: "",
    mode: "",
    bank_ref_num: "",
    payment_gateway: "",
    longurl: String(pick(["longurl"]) || ""),
    shorturl: String(pick(["shorturl"]) || ""),
    redirect_url: String(pick(["redirect_url"]) || ""),
    webhook: String(pick(["webhook"]) || ""),
    instrument_type: String(pick(["instrument_type"]) || ""),
    action: "",
    error_code: "",
    source_txn_status: "",
    created_at: created ? created.toISOString() : String(createdAt || ""),
    updated_at: updated ? updated.toISOString() : String(updatedAt || ""),
    date: created ? created.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).replace(/ /g, "-") : String(createdAt || ""),
    day: created ? new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(created) : "",
    time: created ? created.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase() : "",
  });
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
  }).filter(isSuccessfulPayment);
}

async function fetchPage(url, headers) {
  return fetchJson(url, { headers });
}

function normalizeInstamojoV2Payment(raw = {}) {
  const pick = (keys) => {
    for (const k of keys) {
      const v = raw?.[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") return v;
    }
    return "";
  };
  const amount = Number(pick(["amount", "paid_amount", "amount_settled", "order_amount"]) || 0);
  const createdAt = pick(["created_at", "created", "date", "payment_date", "payment_created_at"]);
  const updatedAt = pick(["updated_at", "updated", "modified_at", "modified", "payment_updated_at"]);
  const sourcePurpose = String(pick(["purpose", "title", "description"]) || "");
  const created = parseDate(createdAt);
  const updated = parseDate(updatedAt);
  const id = String(pick(["payment_id", "id", "transaction", "payment"]) || globalThis.crypto?.randomUUID?.() || `${Date.now()}`);
  const requestId = String(pick(["payment_request_id", "request_id", "order_id", "payment_request"]) || "");
  const statusRaw = pick(["status", "payment_status", "payment_state"]);
  const status = statusRaw === true ? "Completed" : statusRaw === false ? "Failed" : String(statusRaw || "Unknown");
  return finalizeInstamojoRow({
    transaction: id,
    request_id: requestId,
    status,
    amount,
    category: classifyAmount(amount, sourcePurpose),
    amount_bucket: amount === 99 ? "99" : amount === 198 ? "198" : amount > 500 ? "500+" : "Other",
    source: "Instamojo",
    provider: "Instamojo",
    name: String(pick(["buyer_name", "name", "buyer"]) || ""),
    phone: String(pick(["buyer_phone", "phone"]) || ""),
    email: String(pick(["buyer_email", "email", "buyer"]) || ""),
    purpose: sourcePurpose,
    source_purpose: sourcePurpose,
    bank_name: String(pick(["bank_name", "bank"]) || ""),
    mode: String(pick(["mode", "payment_method"]) || ""),
    bank_ref_num: String(pick(["bank_ref_num", "bank_ref_no", "reference_no"]) || ""),
    payment_gateway: String(pick(["payment_gateway", "gateway"]) || ""),
    instrument_type: String(pick(["instrument_type", "payment_method", "mode"]) || ""),
    action: String(pick(["action"]) || ""),
    error_code: String(pick(["error_code", "error"]) || ""),
    source_txn_status: String(statusRaw === true ? "true" : pick(["payment_status", "status"]) || ""),
    longurl: String(pick(["longurl"]) || ""),
    shorturl: String(pick(["shorturl"]) || ""),
    redirect_url: String(pick(["redirect_url"]) || ""),
    webhook: String(pick(["webhook"]) || ""),
    created_at: created ? created.toISOString() : String(createdAt || ""),
    updated_at: updated ? updated.toISOString() : String(updatedAt || ""),
    date: created ? created.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).replace(/ /g, "-") : String(createdAt || ""),
    day: created ? new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(created) : "",
    time: created ? created.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase() : "",
  });
}

function normalizeInstamojoV2PaymentRequest(raw = {}) {
  const pick = (keys) => {
    for (const k of keys) {
      const v = raw?.[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") return v;
    }
    return "";
  };
  const requestId = String(pick(["payment_request_id", "id", "request_id", "payment_request"]) || "");
  const purpose = String(pick(["purpose", "title", "description"]) || "");
  return {
    request_id: requestId,
    purpose,
    source_purpose: purpose,
    name: String(pick(["buyer_name", "name", "buyer"]) || ""),
    phone: String(pick(["buyer_phone", "phone"]) || ""),
    email: String(pick(["buyer_email", "email", "buyer"]) || ""),
  };
}

export function finalizeInstamojoRow(row = {}) {
  const purpose = String(row.purpose || row.source_purpose || "");
  const amount = Number(row.amount || 0);
  return {
    ...row,
    purpose,
    source_purpose: String(row.source_purpose || purpose),
    category: classifyAmount(amount, purpose),
    amount_bucket: amount === 99 ? "99" : amount === 198 ? "198" : amount > 500 ? "500+" : "Other",
  };
}

async function refreshInstamojoAccessToken() {
  const access = process.env.INSTAMOJO_ACCESS_TOKEN;
  if (access) return access;
  const refresh = process.env.INSTAMOJO_REFRESH_TOKEN;
  const clientId = process.env.INSTAMOJO_CLIENT_ID;
  const clientSecret = process.env.INSTAMOJO_CLIENT_SECRET;
  if (!refresh || !clientId || !clientSecret) return "";
  const { json } = await fetchJson("https://www.instamojo.com/oauth2/token/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refresh,
    }),
  });
  return String(json?.access_token || "");
}

async function fetchInstamojoV2Rows() {
  loadEnvFiles();
  try {
    const token = await refreshInstamojoAccessToken();
    if (!token) return [];
    const base = process.env.INSTAMOJO_V2_BASE_URL || "https://api.instamojo.com";
    const cachedFiles = [path.join(process.cwd(), "public", "data", "all", "transactions.json"), path.join(process.cwd(), "public", "data", "transactions.json")];
    const cachedDates = cachedFiles.flatMap((file) => {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8")).map((r) => parseDate(r.created_at || r.updated_at || r.date)).filter(Boolean);
      } catch {
        return [];
      }
    }).sort((a, b) => a - b);
    const start = process.env.INSTAMOJO_START_DATE ? parseDate(process.env.INSTAMOJO_START_DATE) : new Date(Date.now() - 7 * 86400000);
    const end = new Date();
    const from = start || new Date(Date.UTC(end.getUTCFullYear() - 1, 0, 1));
    const rows = [];
    for (let cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())); cur <= end;) {
      const to = new Date(Math.min(new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth(), cur.getUTCDate() + 29, 23, 59, 59, 999)).getTime(), end.getTime()));
      let page = 1;
      while (true) {
        const url = new URL(`${base}/v2/payments/`);
        url.searchParams.set("min_created_at", cur.toISOString());
        url.searchParams.set("max_created_at", to.toISOString());
        url.searchParams.set("page", String(page));
        url.searchParams.set("limit", "500");
        const { json } = await fetchJson(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
        const batch = Array.isArray(json) ? json : (json?.payments || json?.results || json?.data || []);
        rows.push(...batch.map(normalizeInstamojoV2Payment).filter(isSuccessfulPayment));
        const next = json?.next || "";
        if (!next || batch.length < 500) break;
        page += 1;
      }
      if (to.getTime() >= end.getTime()) break;
      cur = new Date(to.getTime() + 86400000);
    }
    return sortRows(rows);
  } catch {
    return [];
  }
}

async function fetchInstamojoV1Rows() {
  loadEnvFiles();
  const key = process.env.INSTAMOJO_API_KEY;
  const token = process.env.INSTAMOJO_AUTH_TOKEN;
  if (!key || !token) return [];
  const headers = { "X-Api-Key": key, "X-Auth-Token": token };
  const base = process.env.INSTAMOJO_BASE_URL || "https://www.instamojo.com";
  try {
    const first = await fetchPage(`${base}/api/1.1/payment-requests/?page=1&limit=100`, headers);
    const payload = first.json || {};
    const rows = Array.isArray(payload) ? payload : (payload.payment_requests || payload.results || payload.data || []);
    return sortRows(rows.map((r) => normalizePayment(r, r)).filter(isSuccessfulPayment));
  } catch {
    return [];
  }
}

function rowFingerprint(row = {}) {
  return [row.amount || "", row.name || "", row.phone || "", row.email || "", row.purpose || "", row.date || "", row.time || ""].join("|");
}

function paymentRequestKey(value = "") {
  const s = String(value || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s.replace(/\/+$/, "/");
  return s;
}

function paymentRequestUrl(base, requestId) {
  const s = String(requestId || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  return `${base.replace(/\/+$/, "")}/v2/payment_requests/${encodeURIComponent(s)}/`;
}

function mergeInstamojoRows(v2Rows, v1Rows) {
  const out = v2Rows.map((r) => finalizeInstamojoRow({ ...r }));
  const fingerprints = new Set(out.map(rowFingerprint));
  const requestIndex = new Map();
  out.forEach((row, idx) => {
    const req = String(row.request_id || "").trim();
    if (req && !requestIndex.has(req)) requestIndex.set(req, idx);
  });
  for (const row of v1Rows) {
    const req = String(row.transaction || row.request_id || "").trim();
    const fp = rowFingerprint(row);
    const idx = req && requestIndex.has(req) ? requestIndex.get(req) : out.findIndex((r) => rowFingerprint(r) === fp);
    if (idx >= 0) {
      out[idx] = finalizeInstamojoRow({
        ...row,
        ...out[idx],
        purpose: out[idx].purpose || row.purpose || row.source_purpose || "",
        source_purpose: out[idx].source_purpose || row.source_purpose || row.purpose || "",
      });
      fingerprints.add(fp);
      continue;
    }
    if (fingerprints.has(fp)) continue;
    out.push(finalizeInstamojoRow({ ...row }));
    fingerprints.add(fp);
  }
  return sortRows(out);
}

async function enrichInstamojoRowsWithPaymentRequests(rows, base, token) {
  const needs = [...new Set(rows
    .filter((r) => !String(r.purpose || "").trim() || !String(r.name || "").trim() || !String(r.phone || "").trim() || !String(r.email || "").trim())
    .map((r) => paymentRequestKey(r.request_id))
    .filter(Boolean))];
  if (!needs.length) return rows.map((r) => finalizeInstamojoRow({ ...r }));
  const details = new Map();
  await Promise.all(needs.map(async (requestId) => {
    try {
      const { json } = await fetchJson(paymentRequestUrl(base, requestId), { headers: { Authorization: `Bearer ${token}` } });
      const raw = json?.payment_request || json?.data || json?.result || json || {};
      const norm = normalizeInstamojoV2PaymentRequest(raw);
      const key = paymentRequestKey(norm.request_id || requestId);
      if (key) details.set(key, norm);
    } catch {}
  }));
  return rows.map((row) => {
    const key = paymentRequestKey(row.request_id);
    const extra = details.get(key) || {};
    return finalizeInstamojoRow({
      ...row,
      ...extra,
      request_id: row.request_id || extra.request_id || "",
      purpose: row.purpose || extra.purpose || row.source_purpose || extra.source_purpose || "",
      source_purpose: row.source_purpose || extra.source_purpose || row.purpose || extra.purpose || "",
      name: row.name || extra.name || "",
      phone: row.phone || extra.phone || "",
      email: row.email || extra.email || "",
    });
  });
}

export async function fetchInstamojoRows() {
  loadEnvFiles();
  const cachedPath = path.join(process.cwd(), "public", "data", "transactions.json");
  const cached = fs.existsSync(cachedPath) ? JSON.parse(fs.readFileSync(cachedPath, "utf8")) : [];
  const map = new Map(cached.map(r => [[r.source, r.transaction].join("|"), r]));

  const [v2Rows, v1Rows] = await Promise.all([fetchInstamojoV2Rows(), fetchInstamojoV1Rows()]);
  const merged = v2Rows.length ? mergeInstamojoRows(v2Rows, v1Rows) : v1Rows;
  let enriched = merged;
  if (merged.length && v2Rows.length) {
    const base = process.env.INSTAMOJO_V2_BASE_URL || "https://api.instamojo.com";
    const token = await refreshInstamojoAccessToken();
    if (token) {
      try {
        enriched = await enrichInstamojoRowsWithPaymentRequests(merged, base, token);
      } catch {}
    }
  }

  for (const row of enriched) {
    map.set([row.source, row.transaction].join("|"), row);
  }

  return sortRows(Array.from(map.values()));
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
    if (status.toLowerCase() === "completed" || status.toLowerCase() === "credit" || status.toLowerCase() === "success" || status.toLowerCase() === "captured") {
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
  const cols = ["source","provider","transaction","request_id","status","amount","category","amount_bucket","name","phone","email","purpose","source_purpose","bank_name","mode","bank_ref_num","payment_gateway","date","day","time","created_at","updated_at","longurl","shorturl","redirect_url","webhook","instrument_type","action","error_code","source_txn_status"];
  const esc = (v, c) => {
    let s = String(v ?? "");
    if (c === "phone" && s) s = `\t${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c], c)).join(","))].join("\n");
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
