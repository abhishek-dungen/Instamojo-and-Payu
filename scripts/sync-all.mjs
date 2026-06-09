import fs from "node:fs";
import path from "node:path";
import { fetchCashfreeRows, toCsv as toCsvCashfree } from "../lib/cashfree.mjs";
import { fetchPayuRows, toCsv as toCsvPayu } from "../lib/payu.mjs";
import { fetchInstamojoRows, summarize, sortRows, toCsv } from "../lib/instamojo.mjs";

const root = process.cwd();
const dir = path.join(root, "public", "data");
const writeJson = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); };
const keyOf = (r) => [r.source, r.transaction].join("|");

const [instamojo, payu, cashfree] = await Promise.all([fetchInstamojoRows(), fetchPayuRows(), fetchCashfreeRows()]);
writeJson(path.join(dir, "transactions.json"), instamojo);
writeJson(path.join(dir, "summary.json"), { ...summarize(instamojo), generated_at: new Date().toISOString() });
fs.writeFileSync(path.join(dir, "transactions.csv"), toCsv(instamojo));
writeJson(path.join(dir, "payu", "transactions.json"), payu);
writeJson(path.join(dir, "cashfree", "transactions.json"), cashfree);
writeJson(path.join(dir, "payu", "summary.json"), { ...summarize(payu), generated_at: new Date().toISOString() });
writeJson(path.join(dir, "cashfree", "summary.json"), { ...summarize(cashfree), generated_at: new Date().toISOString() });
fs.writeFileSync(path.join(dir, "payu", "transactions.csv"), toCsvPayu(payu));
fs.writeFileSync(path.join(dir, "cashfree", "transactions.csv"), toCsvCashfree(cashfree));
const rows = sortRows([...instamojo, ...payu, ...cashfree].reduce((m, r) => m.set(keyOf(r), r), new Map()).values());
const summary = { ...summarize(rows), generated_at: new Date().toISOString() };

writeJson(path.join(dir, "all", "transactions.json"), rows);
writeJson(path.join(dir, "all", "summary.json"), summary);
fs.writeFileSync(path.join(dir, "all", "transactions.csv"), toCsv(rows));

async function syncFirestore() {
  let getFirestore, Timestamp, cert, getApps, initializeApp;
  try {
    ({ getFirestore, Timestamp } = await import("firebase-admin/firestore"));
    ({ cert, getApps, initializeApp } = await import("firebase-admin/app"));
  } catch {
    return;
  }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
  const file = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || path.join(root, "..", "instamojo-and-payu-firebase-adminsdk-fbsvc-ca77eebb01.json");
  const json = raw.trim().startsWith("{") ? raw : (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
  if (!json.trim()) return;
  const cred = cert(JSON.parse(json));
  if (!getApps().length) initializeApp({ credential: cred });
  const db = getFirestore();
  for (let i = 0; i < rows.length; i += 350) {
    const batch = db.batch();
    for (const row of rows.slice(i, i + 350)) batch.set(db.collection("payments").doc(keyOf(row)), row, { merge: true });
    await batch.commit();
  }
  await db.collection("meta").doc("payments").set({
    generated_at: summary.generated_at,
    count: rows.length,
    totals: summary.totals,
    updated_at: Timestamp.now(),
  }, { merge: true });
}

await syncFirestore().catch(() => {});
console.log(JSON.stringify({ rows: rows.length, ...summary.totals }, null, 2));
