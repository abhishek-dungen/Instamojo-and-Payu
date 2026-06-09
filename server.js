import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const publicDir = path.join(root, "public");
const dataDir = path.join(root, "data");
const dataFile = path.join(dataDir, "transactions.json");
const envFile = path.join(root, ".env.local");

if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const fmtDay = (d) => new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(d);
const fmtTime = (d) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase();
const baseUrls = [process.env.INSTAMOJO_BASE_URL || "https://www.instamojo.com"];

const rowKey = (r) => [r.transaction, r.name, r.phone, r.email, r.amount, r.date, r.time].join("|");
const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

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

function category(amount) {
  if (amount === 99) return "Webinar";
  if (amount === 198) return "Bundle";
  if (amount > 500) return "Course";
  return "Other";
}

function pick(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return "";
}

function normalize(raw = {}, fallback = {}) {
  const amount = Number(pick(raw, ["amount", "total_amount"]) || pick(fallback, ["amount"]) || 0);
  const dateRaw = pick(raw, ["created_at", "created", "date", "payment_date", "payment_time", "payment_created_at"]) || pick(fallback, ["created_at", "created", "date"]);
  const dt = parseDate(dateRaw);
  const tx = String(pick(raw, ["payment_id", "id", "transaction", "payment"]) || pick(fallback, ["payment_id", "id", "transaction"]) || "");
  const name = String(pick(raw, ["buyer_name", "name", "buyer"]) || pick(fallback, ["buyer_name", "name"]) || "");
  const phone = String(pick(raw, ["buyer_phone", "phone"]) || pick(fallback, ["phone"]) || "");
  const email = String(pick(raw, ["email", "buyer_email"]) || pick(fallback, ["email"]) || "");
  return {
    transaction: tx,
    name,
    phone,
    email,
    source: "Instamojo",
    category: category(amount),
    amount,
    date: dt ? dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).replace(/ /g, "-") : String(dateRaw || ""),
    day: dt ? fmtDay(dt) : String(pick(raw, ["day"]) || pick(fallback, ["day"]) || ""),
    time: dt ? fmtTime(dt) : String(pick(raw, ["time"]) || pick(fallback, ["time"]) || ""),
  };
}

function flattenRecords(x, out = []) {
  if (!x || typeof x !== "object") return out;
  const keys = ["payment_id", "buyer_name", "buyer_phone", "status", "payment_request_id", "amount"];
  if (keys.some((k) => k in x)) out.push(x);
  for (const v of Object.values(x)) if (v && typeof v === "object") flattenRecords(v, out);
  return out;
}

async function fetchJson(url, headers) {
  const args = ["-sS", "-L", url];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  args.push("-w", "\n%{http_code}");
  let out;
  try {
    out = execFileSync("curl", args, { encoding: "utf8" });
  } catch (e) {
    throw new Error(String(e.stderr || e.stdout || e.message || e).slice(0, 120));
  }
  const i = out.lastIndexOf("\n");
  const txt = out.slice(0, i);
  const code = Number(out.slice(i + 1).trim());
  if (code < 200 || code >= 300) throw new Error(`HTTP ${code}: ${txt.slice(0, 120)}`);
  try { return JSON.parse(txt); } catch { return txt; }
}

async function fetchAllPayments() {
  const key = process.env.INSTAMOJO_API_KEY;
  const token = process.env.INSTAMOJO_AUTH_TOKEN;
  if (!key || !token) return [];
  const headers = { "X-Api-Key": key, "X-Auth-Token": token };
  let lastErr = "";
  for (const base of baseUrls) {
    try {
      const first = await fetchJson(`${base}/api/1.1/payment-requests/?page=1&limit=500`, headers);
      const pages = Number(first.pages || first.total_pages || 1) || 1;
      const requests = [];
      const rows = first.payment_requests || first.paymentRequests || first.data || first.results || first || [];
      if (Array.isArray(rows)) requests.push(...rows);
      for (let page = 2; page <= pages; page++) {
        const more = await fetchJson(`${base}/api/1.1/payment-requests/?page=${page}&limit=500`, headers);
        const rs = more.payment_requests || more.paymentRequests || more.data || more.results || more || [];
        if (Array.isArray(rs)) requests.push(...rs);
      }
      const out = [];
      for (const req of requests) {
        const detailId = pick(req, ["id", "payment_request_id"]);
        if (detailId) {
          try {
            const detail = await fetchJson(`${base}/api/1.1/payment-requests/${detailId}/`, headers);
            const paymentObjs = flattenRecords(detail);
            if (paymentObjs.length) {
              for (const p of paymentObjs) out.push(normalize(p, req));
              continue;
            }
            const reqNorm = normalize(detail, req);
            if (reqNorm.transaction || reqNorm.name || reqNorm.amount) out.push(reqNorm);
            continue;
          } catch {}
        }
        const direct = flattenRecords(req);
        if (direct.length) {
          for (const p of direct) out.push(normalize(p, req));
        } else {
          const n = normalize(req);
          if (n.transaction || n.name || n.amount) out.push(n);
        }
      }
      const uniq = new Map();
      for (const r of [...out, ...readJson(dataFile, [])]) uniq.set(rowKey(r), r);
      return { rows: [...uniq.values()], mode: "live", error: "" };
    } catch (e) {
      lastErr = String(e.message || e);
    }
  }
  const cached = readJson(dataFile, []);
  return { rows: cached, mode: cached.length ? "cache" : "empty", error: lastErr || "instamojo_unavailable" };
}

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const file = url.pathname === "/" ? "/index.html" : url.pathname;
  const target = path.join(publicDir, file);
  if (!target.startsWith(publicDir) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) return send(res, 404, "Not found", "text/plain");
  const ext = path.extname(target);
  const type = ext === ".html" ? "text/html" : ext === ".css" ? "text/css" : "text/javascript";
  res.writeHead(200, { "content-type": type });
  fs.createReadStream(target).pipe(res);
}

async function readBody(req) {
  return await new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/api/payments") return send(res, 200, await fetchAllPayments());
    if (url.pathname === "/api/ingest" && req.method === "POST") {
      const body = await readBody(req);
      const data = JSON.parse(body || "{}");
      const rows = Array.isArray(data.rows) ? data.rows.map((r) => normalize(r, r)) : data.payment_id ? [normalize(data, data)] : [];
      const existing = readJson(dataFile, []);
      const uniq = new Map([...existing, ...rows].map((r) => [rowKey(r), r]));
      writeJson(dataFile, [...uniq.values()]);
      return send(res, 200, { ok: true, count: uniq.size });
    }
    return serveStatic(req, res);
  } catch (e) {
    return send(res, 500, { error: String(e.message || e) });
  }
}).listen(process.env.PORT || 3001);
