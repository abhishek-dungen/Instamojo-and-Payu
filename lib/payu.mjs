import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { classifyAmount, isSuccessfulPayment, loadEnvFiles, parseDate, sortRows, summarize, toCsv } from "./instamojo.mjs";

const apiUrl = () => process.env.PAYU_BASE_URL || "https://info.payu.in/merchant/postservice.php?form=2";

const keyOf = (r) => [r.transaction || "", r.request_id || "", r.created_at || ""].join("|");
const hash = (s) => crypto.createHash("sha512").update(s).digest("hex");
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));

function rangeFromEnv() {
  const start = process.env.PAYU_START_DATE && parseDate(process.env.PAYU_START_DATE);
  const end = process.env.PAYU_END_DATE && parseDate(process.env.PAYU_END_DATE);
  if (start && end) return { start, end };
  try {
    const rows = JSON.parse(fs.readFileSync("public/data/payu/transactions.json", "utf8"));
    const dates = rows.map((r) => parseDate(r.created_at || r.addedon)).filter(Boolean).sort((a, b) => a - b);
    if (dates.length) return { start: dates[0], end: dates[dates.length - 1] };
  } catch {}
  const end2 = new Date();
  const start2 = new Date(Date.UTC(end2.getUTCFullYear(), end2.getUTCMonth(), end2.getUTCDate() - 6));
  return { start: start2, end: end2 };
}

function chunks(start, end, days = 7) {
  const out = [];
  let cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (cur <= last) {
    const to = new Date(Math.min(addDays(cur, days - 1).getTime(), last.getTime()));
    out.push([iso(cur), iso(to)]);
    cur = addDays(to, 1);
  }
  return out;
}

function pick(raw, keys) {
  for (const k of keys) {
    const v = raw?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return "";
}

export function normalizePayuPayment(raw = {}) {
  const first = String(pick(raw, ["firstname", "first_name", "name"]) || "").trim();
  const last = String(pick(raw, ["lastname", "last_name"]) || "").trim();
  const amount = Number(pick(raw, ["amt", "amount", "amount_settled"]) || 0);
  const created = parseDate(pick(raw, ["addedon", "created_at", "created"])) || null;
  const status = String(pick(raw, ["status", "txnid_status", "transaction_status"]) || "").trim();
  return {
    provider: "PayU",
    source: "PayU",
    transaction: String(pick(raw, ["id", "mihpayid", "txnid", "request_id"]) || ""),
    request_id: String(pick(raw, ["txnid", "request_id"]) || ""),
    status,
    amount,
    category: classifyAmount(amount),
    amount_bucket: amount === 99 ? "99" : amount === 198 ? "198" : amount > 500 ? "500+" : "Other",
    name: [first, last].filter(Boolean).join(" ").trim(),
    phone: String(pick(raw, ["phone"]) || "").trim(),
    email: String(pick(raw, ["email"]) || "").trim(),
    purpose: String(pick(raw, ["productinfo", "purpose"]) || ""),
    bank_name: String(pick(raw, ["bank_name", "bankcode"]) || ""),
    mode: String(pick(raw, ["mode", "PG_TYPE"]) || ""),
    bank_ref_num: String(pick(raw, ["bank_ref_num", "bank_ref_no", "mihpayid"]) || ""),
    payment_gateway: String(pick(raw, ["PG_TYPE", "payment_gateway"]) || ""),
    action: String(pick(raw, ["action"]) || ""),
    error_code: String(pick(raw, ["error", "error_Message"]) || ""),
    source_txn_status: String(pick(raw, ["field9", "txn_status"]) || ""),
    instrument_type: String(pick(raw, ["payment_source", "mode", "PG_TYPE"]) || ""),
    longurl: "",
    shorturl: "",
    redirect_url: "",
    webhook: "",
    created_at: created ? created.toISOString() : String(pick(raw, ["addedon", "created_at"]) || ""),
    updated_at: "",
    date: created ? created.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).replace(/ /g, "-") : "",
    day: created ? new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(created) : "",
    time: created ? created.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase() : "",
  };
}

async function post(url, params) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20000);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: ac.signal,
  }).finally(() => clearTimeout(t));
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  return json;
}

function unwrapTransactions(json) {
  if (Array.isArray(json)) return json;
  const nodes = [json, json?.result, json?.data, json?.transaction_details, json?.Transaction_details, json?.response, json?.response?.data];
  for (const node of nodes) {
    if (Array.isArray(node)) return node;
    if (node && typeof node === "object") {
      for (const v of Object.values(node)) if (Array.isArray(v)) return v;
    }
  }
  return [];
}

async function fetchWindow(start, end) {
  const key = process.env.PAYU_KEY;
  const salt = process.env.PAYU_SALT;
  if (!key || !salt) return [];
  const json = await post(apiUrl(), {
    key,
    command: "get_Transaction_Details",
    var1: start,
    var2: end,
    hash: hash(`${key}|get_Transaction_Details|${start}|${salt}`),
  });
  return unwrapTransactions(json).map(normalizePayuPayment).filter(isSuccessfulPayment);
}

export async function fetchPayuRows() {
  loadEnvFiles();
  try {
    const { start, end } = rangeFromEnv();
    const rows = [];
    for (const [a, b] of chunks(start, end, 7)) rows.push(...await fetchWindow(a, b));
    return sortRows([...rows].reduce((m, r) => m.set(keyOf(r), r), new Map()).values());
  } catch {
    const cached = path.join(process.cwd(), "public", "data", "payu", "transactions.json");
    if (fs.existsSync(cached)) return sortRows(JSON.parse(fs.readFileSync(cached, "utf8")));
    return [];
  }
}

export { summarize, toCsv };
