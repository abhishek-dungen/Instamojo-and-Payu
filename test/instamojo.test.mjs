import test from "node:test";
import assert from "node:assert/strict";
import { classifyAmount, finalizeInstamojoRow } from "../lib/instamojo.mjs";

test("99 bundle upsell is classified as Bundle", () => {
  assert.equal(classifyAmount(99, "Ultimate Resource Bundle"), "Bundle");
  assert.equal(finalizeInstamojoRow({ amount: 99, purpose: "Ultimate Resource Bundle" }).category, "Bundle");
  assert.equal(finalizeInstamojoRow({ amount: 99, source_purpose: "Ultimate Resource Bundle" }).category, "Bundle");
});

test("plain 99 remains Webinar", () => {
  assert.equal(classifyAmount(99, ""), "Webinar");
});
