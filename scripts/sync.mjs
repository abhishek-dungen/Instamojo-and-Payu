import fs from "node:fs";
import path from "node:path";
import { isSuccessfulPayment, loadEnvFiles, normalizePayment, readCsvPayments, sortRows, summarize, toCsv } from "../lib/instamojo.mjs";

loadEnvFiles();

const root = process.cwd();
const publicDir = path.join(root, "public");
const dataDir = path.join(publicDir, "data");
const rowsFile = path.join(dataDir, "transactions.json");
const summaryFile = path.join(dataDir, "summary.json");
const csvFile = path.join(dataDir, "transactions.csv");
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
  if (!key || !token) throw new Error("Missing INSTAMOJO_API_KEY or INSTAMOJO_AUTH_TOKEN");
  const headers = { "X-Api-Key": key, "X-Auth-Token": token };
  const base = process.env.INSTAMOJO_BASE_URL || "https://www.instamojo.com";
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
}

let remoteRows = [];
try { remoteRows = await fetchInstamojoRows(); } catch { remoteRows = []; }
const seedRows = remoteRows.length ? remoteRows : readCsvPayments(fallbackCsv);
const cachedRows = readJson(rowsFile, []).filter(isSuccessfulPayment);
const rows = sortRows([...seedRows, ...cachedRows].reduce((m, r) => m.set(r.transaction, r), new Map()).values());
const summary = { ...summarize(rows), generated_at: new Date().toISOString() };
writeJson(rowsFile, rows);
writeJson(summaryFile, summary);
fs.mkdirSync(path.dirname(csvFile), { recursive: true });
fs.writeFileSync(csvFile, toCsv(rows));
console.log(JSON.stringify({ rows: rows.length, ...summary.totals }, null, 2));
