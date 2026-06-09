import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const root = process.cwd();
const publicData = path.join(root, "public", "data", "transactions.json");
const saPath = process.env.FIREBASE_SERVICE_ACCOUNT_FILE || path.join(root, "instamojo-and-payu-firebase-adminsdk-fbsvc-446174bd36.json");
const envFile = path.join(root, ".env.local");
const baseUrls = [process.env.INSTAMOJO_BASE_URL || "https://www.instamojo.com"];

if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  if (!isNaN(d)) return d;
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m) {
    const d2 = new Date(`${m[1]} ${m[2]} ${m[3]} 00:00:00`);
    if (!isNaN(d2)) return d2;
  }
  return null;
}
const fmtDay = (d) => new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(d);
const fmtTime = (d) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase();
const pick = (obj, keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return "";
};
const category = (amount) => amount === 99 ? "Webinar" : amount === 198 ? "Bundle" : amount > 500 ? "Course" : "Other";
const rowKey = (r) => [r.transaction, r.name, r.phone, r.email, r.amount, r.date, r.time].join("|");
function normalize(raw = {}, fallback = {}) {
  const amount = Number(pick(raw, ["amount", "total_amount"]) || pick(fallback, ["amount"]) || 0);
  const dateRaw = pick(raw, ["created_at", "created", "date", "payment_date", "payment_time", "payment_created_at"]) || pick(fallback, ["created_at", "created", "date"]);
  const dt = parseDate(dateRaw);
  return {
    transaction: String(pick(raw, ["payment_id", "id", "transaction", "payment"]) || pick(fallback, ["payment_id", "id", "transaction"]) || randomUUID()),
    name: String(pick(raw, ["buyer_name", "name", "buyer"]) || pick(fallback, ["buyer_name", "name"]) || ""),
    phone: String(pick(raw, ["buyer_phone", "phone"]) || pick(fallback, ["phone"]) || ""),
    email: String(pick(raw, ["email", "buyer_email"]) || pick(fallback, ["email"]) || ""),
    source: "Instamojo",
    category: category(amount),
    amount,
    date: dt ? dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).replace(/ /g, "-") : String(dateRaw || ""),
    day: dt ? fmtDay(dt) : String(pick(raw, ["day"]) || pick(fallback, ["day"]) || ""),
    time: dt ? fmtTime(dt) : String(pick(raw, ["time"]) || pick(fallback, ["time"]) || ""),
  };
}
function fetchJson(url, headers) {
  const args = ["-sS", "-L", url];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  args.push("-w", "\n%{http_code}");
  const out = execFileSync("curl", args, { encoding: "utf8" });
  const i = out.lastIndexOf("\n");
  const txt = out.slice(0, i);
  const code = Number(out.slice(i + 1).trim());
  if (code < 200 || code >= 300) throw new Error(`HTTP ${code}: ${txt.slice(0, 120)}`);
  return JSON.parse(txt);
}
async function fetchAllPayments() {
  const key = process.env.INSTAMOJO_API_KEY;
  const token = process.env.INSTAMOJO_AUTH_TOKEN;
  if (!key || !token) return [];
  const headers = { "X-Api-Key": key, "X-Auth-Token": token };
  let lastErr = "";
  for (const base of baseUrls) {
    try {
      const first = fetchJson(`${base}/api/1.1/payment-requests/?page=1&limit=500`, headers);
      const pages = Number(first.pages || first.total_pages || 1) || 1;
      const requests = [];
      const rows = first.payment_requests || first.paymentRequests || first.data || first.results || first || [];
      if (Array.isArray(rows)) requests.push(...rows);
      for (let page = 2; page <= pages; page++) {
        const more = fetchJson(`${base}/api/1.1/payment-requests/?page=${page}&limit=500`, headers);
        const rs = more.payment_requests || more.paymentRequests || more.data || more.results || more || [];
        if (Array.isArray(rs)) requests.push(...rs);
      }
      const out = [];
      for (const req of requests) {
        const detailId = pick(req, ["id", "payment_request_id"]);
        if (detailId) {
          try {
            const detail = fetchJson(`${base}/api/1.1/payment-requests/${detailId}/`, headers);
            const paymentObjs = [];
            const stack = [detail];
            while (stack.length) {
              const x = stack.pop();
              if (!x || typeof x !== "object") continue;
              const keys = ["payment_id", "buyer_name", "buyer_phone", "status", "payment_request_id", "amount"];
              if (keys.some((k) => k in x)) paymentObjs.push(x);
              for (const v of Object.values(x)) if (v && typeof v === "object") stack.push(v);
            }
            if (paymentObjs.length) {
              for (const p of paymentObjs) out.push(normalize(p, req));
              continue;
            }
            const reqNorm = normalize(detail, req);
            if (reqNorm.transaction || reqNorm.name || reqNorm.amount) out.push(reqNorm);
            continue;
          } catch {}
        }
        const direct = [];
        const stack = [req];
        while (stack.length) {
          const x = stack.pop();
          if (!x || typeof x !== "object") continue;
          const keys = ["payment_id", "buyer_name", "buyer_phone", "status", "payment_request_id", "amount"];
          if (keys.some((k) => k in x)) direct.push(x);
          for (const v of Object.values(x)) if (v && typeof v === "object") stack.push(v);
        }
        if (direct.length) for (const p of direct) out.push(normalize(p, req));
        else {
          const n = normalize(req);
          if (n.transaction || n.name || n.amount) out.push(n);
        }
      }
      const uniq = new Map();
      for (const r of out) uniq.set(rowKey(r), r);
      return [...uniq.values()];
    } catch (e) {
      lastErr = String(e.message || e);
    }
  }
  throw new Error(lastErr || "instamojo_unavailable");
}

if (!fs.existsSync(saPath)) throw new Error(`Missing service account file: ${saPath}`);
const sa = JSON.parse(fs.readFileSync(saPath, "utf8"));
if (!getApps().length) initializeApp({ credential: cert(sa) });
const db = getFirestore();

const rows = await fetchAllPayments().catch((e) => {
  console.error(String(e.message || e));
  return [];
});
if (rows.length) {
  const batchLimit = 450;
  let batch = db.batch();
  let count = 0;
  for (const row of rows) {
    const id = row.transaction || randomUUID();
    batch.set(db.collection("transactions").doc(id), row, { merge: true });
    count++;
    if (count % batchLimit === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  await batch.commit();
}
const snap = await db.collection("transactions").get();
const exportRows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
fs.mkdirSync(path.dirname(publicData), { recursive: true });
fs.writeFileSync(publicData, JSON.stringify(exportRows, null, 2));
console.log(JSON.stringify({ fetched: rows.length, exported: exportRows.length, firestore: sa.project_id }, null, 2));
