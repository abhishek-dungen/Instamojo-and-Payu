import fs from "node:fs";
import path from "node:path";
import { sortRows, summarize, toCsv } from "../lib/instamojo.mjs";

const root = process.cwd();
const dir = path.join(root, "public", "data");
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
const writeJson = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); };
const keyOf = (r) => [r.source, r.transaction].join("|");

const instamojo = readJson(path.join(dir, "transactions.json"), []);
const payu = readJson(path.join(dir, "payu", "transactions.json"), []);
const rows = sortRows([...instamojo, ...payu].reduce((m, r) => m.set(keyOf(r), r), new Map()).values());
const summary = { ...summarize(rows), generated_at: new Date().toISOString() };
writeJson(path.join(dir, "all", "transactions.json"), rows);
writeJson(path.join(dir, "all", "summary.json"), summary);
fs.writeFileSync(path.join(dir, "all", "transactions.csv"), toCsv(rows));
console.log(JSON.stringify({ rows: rows.length, ...summary.totals }, null, 2));
