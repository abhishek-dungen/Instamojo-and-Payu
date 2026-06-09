import fs from "node:fs";
import path from "node:path";
import { fetchPayuRows, summarize, toCsv } from "../lib/payu.mjs";

const root = process.cwd();
const dir = path.join(root, "public", "data", "payu");
const rowsFile = path.join(dir, "transactions.json");
const summaryFile = path.join(dir, "summary.json");
const csvFile = path.join(dir, "transactions.csv");

const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

const rows = await fetchPayuRows();
const summary = { ...summarize(rows), generated_at: new Date().toISOString() };
writeJson(rowsFile, rows);
writeJson(summaryFile, summary);
fs.writeFileSync(csvFile, toCsv(rows));
console.log(JSON.stringify({ rows: rows.length, ...summary.totals }, null, 2));
