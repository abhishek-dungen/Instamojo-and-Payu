import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";
import { classifyAmount, loadEnvFiles, sortRows, summarize, toCsv } from "./instamojo.mjs";

const root = process.cwd();
const defaultXlsx = path.join(root, "data-sources", "Cashfree Data.xlsx");

function parseXlsxDateTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return "";
  const dStr = String(dateStr).trim();
  const tStr = String(timeStr).trim();
  
  // Date match e.g. "04-Jan-2026"
  const dateMatch = dStr.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!dateMatch) return "";
  
  const day = parseInt(dateMatch[1], 10);
  const monthStr = dateMatch[2];
  const year = parseInt(dateMatch[3], 10);
  
  const months = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
  };
  const month = months[monthStr];
  if (month === undefined) return "";
  
  // Time match e.g. "07:30 PM" or "7:30 pm"
  const timeMatch = tStr.match(/^(\d{1,2}):(\d{2})\s*([ap]m)$/i);
  if (!timeMatch) return "";
  
  let hour = parseInt(timeMatch[1], 10);
  const minute = parseInt(timeMatch[2], 10);
  const ampm = timeMatch[3].toLowerCase();
  
  if (ampm === "pm" && hour !== 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  
  // Date in Asia/Kolkata (IST, UTC+5:30) converted to UTC:
  const utcDate = new Date(Date.UTC(year, month, day, hour, minute, 0));
  utcDate.setUTCMinutes(utcDate.getUTCMinutes() - 330);
  
  return utcDate.toISOString();
}

function readXlsx(file) {
  const workbook = XLSX.readFile(file);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: false });
  
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length === 0 || row.every(cell => cell === null || cell === undefined || cell === '')) {
      continue;
    }
    const [txn, name, phone, email, source, category, amount, date, day, time] = row;
    
    let created_at = "";
    if (date && time) {
      try {
        created_at = parseXlsxDateTime(date, time);
      } catch (e) {
        created_at = "";
      }
    }
    
    rows.push({
      transaction: String(txn ?? ""),
      request_id: "",
      status: "Completed",
      amount: parseInt(amount || 0, 10),
      category: String(category ?? ""),
      amount_bucket: parseInt(amount || 0, 10) === 99 ? "99" : parseInt(amount || 0, 10) === 198 ? "198" : parseInt(amount || 0, 10) > 500 ? "500+" : "Other",
      name: String(name ?? ""),
      phone: String(phone ?? ""),
      email: String(email ?? ""),
      purpose: String(category ?? ""),
      source: "Cashfree",
      provider: "Cashfree",
      instrument_type: "Cashfree",
      date: String(date ?? ""),
      day: String(day ?? ""),
      time: String(time ?? ""),
      created_at,
      updated_at: "",
      longurl: "",
      shorturl: "",
      redirect_url: "",
      webhook: "",
      bank_name: "",
      mode: "",
      bank_ref_num: "",
      payment_gateway: "",
      action: "",
      error_code: "",
      source_txn_status: ""
    });
  }
  return rows;
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
