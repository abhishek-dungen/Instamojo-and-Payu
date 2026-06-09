import crypto from "node:crypto";
import { classifyAmount, isSuccessfulPayment, loadEnvFiles, parseDate, sortRows, summarize, toCsv } from "./instamojo.mjs";

export { loadEnvFiles, sortRows, summarize, toCsv };

export function normalizePayuPayment(raw = {}) {
  const pick = (keys) => {
    for (const k of keys) {
      const v = raw?.[k];
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return "";
  };
  const amount = Number(pick(["amt", "amount", "transaction_amount", "amount_settled"]) || 0);
  const dt = parseDate(pick(["addedon", "added_on", "created_at", "date"]));
  const first = String(pick(["firstname", "first_name", "name"]) || "");
  const last = String(pick(["lastname", "last_name"]) || "");
  return {
    provider: "PayU",
    source: "PayU",
    transaction: String(pick(["txnid", "mihpayid", "id", "request_id"]) || crypto.randomUUID()),
    request_id: String(pick(["request_id"]) || ""),
    status: String(pick(["status"]) || ""),
    amount,
    category: classifyAmount(amount),
    amount_bucket: amount === 99 ? "99" : amount === 198 ? "198" : amount > 500 ? "500+" : "Other",
    name: [first, last].filter(Boolean).join(" ").trim(),
    phone: String(pick(["phone"]) || ""),
    email: String(pick(["email"]) || ""),
    purpose: String(pick(["productinfo", "product_info"]) || ""),
    bank_name: String(pick(["bank_name"]) || ""),
    mode: String(pick(["mode", "bankcode", "ibibo_code"]) || ""),
    bank_ref_num: String(pick(["bank_ref_num", "bank_ref_no"]) || ""),
    payment_gateway: String(pick(["payment_gateway", "PG_TYPE"]) || ""),
    action: String(pick(["action"]) || ""),
    error_code: String(pick(["error_code"]) || ""),
    source_txn_status: String(pick(["unmappedstatus"]) || ""),
    created_at: dt ? dt.toISOString() : String(pick(["addedon"]) || ""),
    updated_at: "",
    date: dt ? dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).replace(/ /g, "-") : String(pick(["addedon"]) || ""),
    day: dt ? new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(dt) : "",
    time: dt ? dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase() : "",
  };
}

export function isSuccessfulPayu(row = {}) {
  const s = String(row.status || "").trim().toLowerCase();
  return s === "captured" || s === "success" || s === "completed";
}

function hash(key, command, var1, salt) {
  return crypto.createHash("sha512").update(`${key}|${command}|${var1}|${salt}`).digest("hex");
}

async function postForm(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { throw new Error(`Invalid JSON: ${text.slice(0, 200)}`); }
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { throw new Error(`Invalid JSON: ${text.slice(0, 200)}`); }
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export async function fetchPayuRows() {
  loadEnvFiles(["safe.env", ".env.local"]);
  const key = process.env.PAYU_KEY;
  const salt = process.env.PAYU_SALT;
  if (!key || !salt) throw new Error("Missing PAYU_KEY or PAYU_SALT");
  const base = process.env.PAYU_BASE_URL || "https://info.payu.in/merchant/postservice.php?form=2";
  const start = new Date(process.env.PAYU_START_DATE || "2010-01-01");
  const end = new Date(process.env.PAYU_END_DATE || new Date().toISOString().slice(0, 10));
  try {
    const out = new Map();
    for (let cur = start; cur <= end; cur = addDays(cur, 31)) {
      const from = fmtDate(cur);
      const to = fmtDate(new Date(Math.min(addDays(cur, 30).getTime(), end.getTime())));
      const cmd = "get_Transaction_Details";
      const h = hash(key, cmd, from, salt);
      let prevSig = "";
      for (let page = 1; page <= 50; page++) {
        const body = { key, command: cmd, var1: from, var2: to, hash: h };
        if (page > 1) body.var3 = String(page);
        const json = await postForm(base, body);
        const rows = Array.isArray(json?.Transaction_details) ? json.Transaction_details : [];
        if (!rows.length) break;
        const sig = rows.slice(0, 3).map((r) => r.txnid || r.mihpayid || r.id).join("|") + `:${rows.length}`;
        if (sig === prevSig) break;
        prevSig = sig;
        let added = 0;
        for (const raw of rows) {
          const row = normalizePayuPayment(raw);
          if (!isSuccessfulPayu(row)) continue;
          const id = row.transaction || row.transaction_id || row.bank_ref_num || crypto.randomUUID();
          if (!out.has(id)) { out.set(id, row); added++; }
        }
        if (added === 0) break;
        if (rows.length < 50) break;
      }
    }
    if (out.size) return sortRows([...out.values()]);
  } catch (e) {
    if (!String(e.message || e).includes("429")) throw e;
  }

  const clientId = process.env.PAYU_CLIENT_ID;
  const clientSecret = process.env.PAYU_CLIENT_SECRET;
  const mid = process.env.PAYU_MID;
  if (!clientId || !clientSecret || !mid) throw new Error("Missing PAYU_CLIENT_ID, PAYU_CLIENT_SECRET or PAYU_MID");
  const accounts = process.env.PAYU_ACCOUNTS_BASE_URL || "https://accounts.payu.in";
  const tokenRes = await fetch(`${accounts}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      scope: "read_payment_links",
    }),
  });
  const tokenJson = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok) throw new Error(`Token error: ${JSON.stringify(tokenJson).slice(0, 200)}`);
  const token = tokenJson.access_token;
  const host = process.env.PAYU_ONEAPI_BASE_URL || "https://oneapi.payu.in/payment-links";
  const pageSize = 100;
  const links = [];
  for (let offset = 0; offset < 10000; offset += pageSize) {
    const url = `${host}?pageSize=${pageSize}&pageOffset=${offset}&dateFrom=${fmtDate(start)}&dateTo=${fmtDate(end)}&orderBy=addedOn&order=desc`;
    const headers = { mid, merchantId: mid, Authorization: `Bearer ${token}` };
    const json = await getJson(url, headers);
    const result = json?.result || {};
    const batch = result.paymentLinksList || [];
    links.push(...batch);
    if (!batch.length || links.length >= Number(result.rows || batch.length)) break;
  }
  const rows = new Map();
  for (const link of links) {
    const invoiceId = link.invoiceNumber;
    if (!invoiceId) continue;
    const url = `${host}/${encodeURIComponent(invoiceId)}/txns?pageSize=100&dateFrom=${fmtDate(start)}&dateTo=${fmtDate(end)}`;
    const headers = { mid, merchantId: mid, Authorization: `Bearer ${token}` };
    const json = await getJson(url, headers);
    const result = json?.result || {};
    for (const tx of result.data || []) {
      const row = normalizePayuPayment({
        txnid: tx.transactionId,
        request_id: tx.merchantReferenceId,
        addedon: tx.createdOn,
        amt: tx.settledAmount,
        email: tx.customerEmail,
        status: tx.status,
        mode: tx.mode,
        bankcode: tx.bankCode,
        productinfo: link.description,
        bank_ref_num: tx.paymentId || "",
      });
      if (!isSuccessfulPayu(row)) continue;
      if (!rows.has(row.transaction)) rows.set(row.transaction, row);
    }
    if (result.pages > 1) {
      for (let page = 2; page <= result.pages; page++) {
        const more = await getJson(`${url}&page=${page}`, headers);
        for (const tx of (more?.result?.data || [])) {
          const row = normalizePayuPayment({
            txnid: tx.transactionId,
            request_id: tx.merchantReferenceId,
            addedon: tx.createdOn,
            amt: tx.settledAmount,
            email: tx.customerEmail,
            status: tx.status,
            mode: tx.mode,
            bankcode: tx.bankCode,
            productinfo: link.description,
            bank_ref_num: tx.paymentId || "",
          });
          if (!isSuccessfulPayu(row)) continue;
          if (!rows.has(row.transaction)) rows.set(row.transaction, row);
        }
      }
    }
  }
  return sortRows([...rows.values()]);
}
