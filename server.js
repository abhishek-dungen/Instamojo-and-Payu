import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { isSuccessfulPayment, loadEnvFiles, normalizePayment, readCsvPayments, sortRows, summarize, toCsv } from "./lib/instamojo.mjs";

loadEnvFiles();

const root = process.cwd();
const publicDir = path.join(root, "public");
const dataDir = path.join(publicDir, "data");
const rowsFile = path.join(dataDir, "transactions.json");
const summaryFile = path.join(dataDir, "summary.json");
const fallbackCsv = path.join(root, "..", "instamojo_transactions.csv");

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

async function fetchPage(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return { json: await res.json(), headers: res.headers };
}

async function fetchInstamojoRows() {
  const key = process.env.INSTAMOJO_API_KEY;
  const token = process.env.INSTAMOJO_AUTH_TOKEN;
  if (!key || !token) return [];
  const headers = { "X-Api-Key": key, "X-Auth-Token": token };
  const bases = [process.env.INSTAMOJO_BASE_URL || "https://www.instamojo.com"];
  let lastErr = "";
  for (const base of bases) {
    try {
      const first = await fetchPage(`${base}/api/1.1/payment-requests/?page=1&limit=500`, headers);
      const payload = first.json || {};
      const rows = Array.isArray(payload) ? payload : (payload.payment_requests || payload.results || payload.data || []);
      const pages = Number(payload.pages || first.headers.get("pages") || 1) || 1;
      const all = [...rows];
      for (let page = 2; page <= pages; page++) {
        const more = await fetchPage(`${base}/api/1.1/payment-requests/?page=${page}&limit=500`, headers);
        const p = more.json || {};
        const moreRows = Array.isArray(p) ? p : (p.payment_requests || p.results || p.data || []);
        all.push(...moreRows);
      }
      return sortRows(all.map((r) => normalizePayment(r, r)).filter(isSuccessfulPayment));
    } catch (e) {
      lastErr = String(e.message || e);
    }
  }
  return readCsvPayments(fallbackCsv);
}

function staticFile(reqPath) {
  const safe = reqPath === "/" ? "/index.html" : reqPath;
  const file = path.join(publicDir, safe);
  if (!file.startsWith(publicDir)) return null;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return null;
  return file;
}

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/api/refresh" && req.method === "POST") {
      const rows = await fetchInstamojoRows();
      const summary = { ...summarize(rows), generated_at: new Date().toISOString() };
      writeJson(rowsFile, rows);
      writeJson(summaryFile, summary);
      return send(res, 200, { ok: true, rows: rows.length, ...summary });
    }
    if (url.pathname === "/api/data") {
      const rows = readJson(rowsFile, []);
      const summary = readJson(summaryFile, summarize(rows));
      return send(res, 200, { rows, summary });
    }
    if (url.pathname === "/api/export.csv") {
      const rows = readJson(rowsFile, []);
      res.writeHead(200, {
        "content-type": "text/csv",
        "content-disposition": 'attachment; filename="instamojo-transactions.csv"',
      });
      return res.end(toCsv(rows));
    }
    const file = staticFile(url.pathname);
    if (file) {
      const ext = path.extname(file).toLowerCase();
      const type = ext === ".html" ? "text/html" : ext === ".css" ? "text/css" : ext === ".js" ? "text/javascript" : ext === ".json" ? "application/json" : "text/plain";
      res.writeHead(200, { "content-type": type });
      return fs.createReadStream(file).pipe(res);
    }
    return send(res, 404, "Not found", "text/plain");
  } catch (e) {
    return send(res, 500, { error: String(e.message || e) });
  }
}).listen(process.env.PORT || 3001);
