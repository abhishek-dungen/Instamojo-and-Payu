import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

import { fetchCashfreeRows } from "./lib/cashfree.mjs";
import { fetchPayuRows } from "./lib/payu.mjs";
import { fetchInstamojoRows, summarize, sortRows } from "./lib/instamojo.mjs";

initializeApp();
const db = getFirestore();

const keyOf = (r) => [r.source, r.transaction].join("|");

export const syncPayments = onSchedule({
  schedule: "every 15 minutes",
  timeoutSeconds: 300,
  memory: "256MiB",
}, async (event) => {
  logger.log("Sync started...");
  try {
    const [instamojo, payu, cashfree] = await Promise.all([
      fetchInstamojoRows(),
      fetchPayuRows(),
      fetchCashfreeRows()
    ]);
    
    logger.log(`Fetched rows count: Instamojo(${instamojo.length}), PayU(${payu.length}), Cashfree(${cashfree.length})`);
    
    const rows = sortRows([...instamojo, ...payu, ...cashfree].reduce((m, r) => m.set(keyOf(r), r), new Map()).values());
    const summary = { ...summarize(rows), generated_at: new Date().toISOString() };
    
    logger.log(`Writing ${rows.length} rows to Firestore in batches...`);
    
    for (let i = 0; i < rows.length; i += 350) {
      const batch = db.batch();
      for (const row of rows.slice(i, i + 350)) {
        batch.set(db.collection("payments").doc(keyOf(row)), row, { merge: true });
      }
      await batch.commit();
    }
    
    logger.log("Writing meta summary to Firestore...");
    await db.collection("meta").doc("payments").set({
      generated_at: summary.generated_at,
      count: rows.length,
      totals: summary.totals,
      updated_at: Timestamp.now(),
    }, { merge: true });
    
    logger.log("Sync completed successfully!");
  } catch (error) {
    logger.error("Sync failed with error:", error);
    throw error;
  }
});
