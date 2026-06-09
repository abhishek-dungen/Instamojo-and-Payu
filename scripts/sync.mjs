import fs from "node:fs";
import path from "node:path";
import { fetchInstamojoRows, summarize, toCsv } from "../lib/instamojo.mjs";

const root = process.cwd();
const publicDir = path.join(root, "public");
const dataDir = path.join(publicDir, "data");
const summaryFile = path.join(dataDir, "summary.json");
const csvFile = path.join(dataDir, "transactions.csv");
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};
const rows = await fetchInstamojoRows();
const summary = { ...summarize(rows), generated_at: new Date().toISOString() };
writeJson(rowsFile, rows);
writeJson(summaryFile, summary);
fs.mkdirSync(path.dirname(csvFile), { recursive: true });
fs.writeFileSync(csvFile, toCsv(rows));
console.log(JSON.stringify({ rows: rows.length, ...summary.totals }, null, 2));
