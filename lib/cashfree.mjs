import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { classifyAmount, loadEnvFiles, sortRows, summarize, toCsv } from "./instamojo.mjs";

const root = process.cwd();
const defaultXlsx = path.join(root, "data-sources", "Cashfree Data.xlsx");

function readXlsx(file) {
  const script = String.raw`
import json, sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from openpyxl import load_workbook

file = sys.argv[1]
wb = load_workbook(file, data_only=True)
ws = wb.active
rows = []
for row in ws.iter_rows(min_row=2, values_only=True):
    if not any(row):
        continue
    txn, name, phone, email, source, category, amount, date, day, time = (list(row) + [None]*10)[:10]
    dt = None
    if date and time:
        try:
            dt = datetime.strptime(f"{date} {time}", "%d-%b-%Y %I:%M %p").replace(tzinfo=ZoneInfo("Asia/Kolkata")).astimezone(timezone.utc)
        except Exception:
            dt = None
    rows.append({
        "transaction": str(txn or ""),
        "request_id": "",
        "status": "Completed",
        "amount": int(amount or 0),
        "category": str(category or ""),
        "amount_bucket": "99" if int(amount or 0) == 99 else "198" if int(amount or 0) == 198 else "500+" if int(amount or 0) > 500 else "Other",
        "name": str(name or ""),
        "phone": str(phone or ""),
        "email": str(email or ""),
        "purpose": str(category or ""),
        "source": "Cashfree",
        "provider": "Cashfree",
        "instrument_type": "Cashfree",
        "date": str(date or ""),
        "day": str(day or ""),
        "time": str(time or ""),
        "created_at": dt.isoformat().replace("+00:00", "Z") if dt else "",
        "updated_at": "",
        "longurl": "",
        "shorturl": "",
        "redirect_url": "",
        "webhook": "",
        "bank_name": "",
        "mode": "",
        "bank_ref_num": "",
        "payment_gateway": "",
        "action": "",
        "error_code": "",
        "source_txn_status": ""
    })
print(json.dumps(rows, ensure_ascii=False))
`;
  const out = execFileSync("python3", ["-", file], { input: script, encoding: "utf8" });
  return JSON.parse(out);
}

export function normalizeCashfreePayment(row = {}) {
  return {
    provider: "Cashfree",
    source: "Cashfree",
    transaction: String(row.transaction || ""),
    request_id: String(row.request_id || ""),
    status: String(row.status || "Completed"),
    amount: Number(row.amount || 0),
    category: String(row.category || classifyAmount(Number(row.amount || 0))),
    amount_bucket: String(row.amount_bucket || (Number(row.amount || 0) === 99 ? "99" : Number(row.amount || 0) === 198 ? "198" : Number(row.amount || 0) > 500 ? "500+" : "Other")),
    name: String(row.name || ""),
    phone: String(row.phone || ""),
    email: String(row.email || ""),
    purpose: String(row.purpose || row.category || ""),
    bank_name: "",
    mode: "",
    bank_ref_num: "",
    payment_gateway: "",
    date: String(row.date || ""),
    day: String(row.day || ""),
    time: String(row.time || ""),
    created_at: String(row.created_at || ""),
    updated_at: "",
    longurl: "",
    shorturl: "",
    redirect_url: "",
    webhook: "",
    instrument_type: "Cashfree",
    action: "",
    error_code: "",
    source_txn_status: "",
  };
}

export async function fetchCashfreeRows() {
  loadEnvFiles();
  const file = process.env.CASHFREE_XLSX_PATH || defaultXlsx;
  if (!fs.existsSync(file)) return [];
  return sortRows(readXlsx(file).map(normalizeCashfreePayment));
}

export { summarize, toCsv };
