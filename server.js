import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fetchCashfreeRows, summarize as summarizeCashfree, toCsv as toCsvCashfree } from "./lib/cashfree.mjs";
import { fetchPayuRows, summarize as summarizePayu, toCsv as toCsvPayu } from "./lib/payu.mjs";
import { isSuccessfulPayment, loadEnvFiles, normalizePayment, readCsvPayments, sortRows, summarize, toCsv } from "./lib/instamojo.mjs";

loadEnvFiles();

const root = process.cwd();
const publicDir = path.join(root, "public");
const dataDir = path.join(publicDir, "data");
const providers = {
  all: {
    rowsFile: path.join(dataDir, "all", "transactions.json"),
    summaryFile: path.join(dataDir, "all", "summary.json"),
    csvName: "all-transactions.csv",
  },
  instamojo: {
    rowsFile: path.join(dataDir, "transactions.json"),
    summaryFile: path.join(dataDir, "summary.json"),
    csvName: "instamojo-all-successful-payments.csv",
  },
  cashfree: {
    rowsFile: path.join(dataDir, "cashfree", "transactions.json"),
    summaryFile: path.join(dataDir, "cashfree", "summary.json"),
    csvName: "cashfree-all-payments.csv",
  },
  payu: {
    rowsFile: path.join(dataDir, "payu", "transactions.json"),
    summaryFile: path.join(dataDir, "payu", "summary.json"),
    csvName: "payu-all-successful-payments.csv",
  },
};

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
const writeJson = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); };
const providerOf = (u) => (u === "instamojo" || u === "cashfree" || u === "payu" ? u : "all");

async function fetchInstamojoRows() {
  const key = process.env.INSTAMOJO_API_KEY;
  const token = process.env.INSTAMOJO_AUTH_TOKEN;
  if (!key || !token) return [];
  const headers = { "X-Api-Key": key, "X-Auth-Token": token };
  const base = process.env.INSTAMOJO_BASE_URL || "https://www.instamojo.com";
  const rows = [];
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(`${base}/api/1.1/payment-requests/?page=${page}&limit=500`, { headers });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const json = await res.json();
    const batch = Array.isArray(json) ? json : (json.payment_requests || json.results || json.data || []);
    rows.push(...batch);
    const totalPages = Number(res.headers.get("pages") || json.pages || json.total_pages || 1) || 1;
    if (page >= totalPages || batch.length < 500) break;
  }
  return sortRows(rows.map((r) => normalizePayment(r, r)).filter(isSuccessfulPayment));
}

async function refresh(provider) {
  if (provider === "all") {
    const [instamojoRows, payuRows, cashfreeRows] = await Promise.all([fetchInstamojoRows(), fetchPayuRows(), fetchCashfreeRows()]);
    const rows = sortRows([...instamojoRows, ...payuRows, ...cashfreeRows]);
    const summary = { ...summarize(rows), generated_at: new Date().toISOString() };
    writeJson(providers.all.rowsFile, rows);
    writeJson(providers.all.summaryFile, summary);
    fs.writeFileSync(path.join(dataDir, "all", "transactions.csv"), `${toCsv(rows)}`);
    return { rows, summary };
  }
  if (provider === "cashfree") {
    const rows = await fetchCashfreeRows();
    const summary = { ...summarizeCashfree(rows), generated_at: new Date().toISOString() };
    writeJson(providers.cashfree.rowsFile, rows);
    writeJson(providers.cashfree.summaryFile, summary);
    fs.writeFileSync(path.join(dataDir, "cashfree", "transactions.csv"), toCsvCashfree(rows));
    return { rows, summary };
  }
  if (provider === "payu") {
    const rows = await fetchPayuRows();
    const summary = { ...summarizePayu(rows), generated_at: new Date().toISOString() };
    writeJson(providers.payu.rowsFile, rows);
    writeJson(providers.payu.summaryFile, summary);
    fs.writeFileSync(path.join(dataDir, "payu", "transactions.csv"), toCsvPayu(rows));
    return { rows, summary };
  }
  const rows = await fetchInstamojoRows();
  const summary = { ...summarize(rows), generated_at: new Date().toISOString() };
  writeJson(providers.instamojo.rowsFile, rows);
  writeJson(providers.instamojo.summaryFile, summary);
  fs.writeFileSync(path.join(dataDir, "transactions.csv"), toCsv(rows));
  return { rows, summary };
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
    const provider = providerOf(url.searchParams.get("provider"));
    if (url.pathname === "/api/refresh" && req.method === "POST") {
      const out = await refresh(provider);
      return send(res, 200, { ok: true, provider, rows: out.rows.length, ...out.summary });
    }
    if (url.pathname === "/api/data") {
      const cfg = providers[provider];
      const rows = readJson(cfg.rowsFile, []);
      const summary = readJson(cfg.summaryFile, provider === "payu" ? summarizePayu(rows) : provider === "cashfree" ? summarizeCashfree(rows) : summarize(rows));
      return send(res, 200, { provider, rows, summary });
    }
    if (url.pathname === "/api/export.csv") {
      const cfg = providers[provider];
      const rows = readJson(cfg.rowsFile, []);
      const csv = provider === "payu" ? toCsvPayu(rows) : provider === "cashfree" ? toCsvCashfree(rows) : toCsv(rows);
      res.writeHead(200, { "content-type": "text/csv", "content-disposition": `attachment; filename="${cfg.csvName}"` });
      return res.end(csv);
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
