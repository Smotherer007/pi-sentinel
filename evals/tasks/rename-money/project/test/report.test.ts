import { test } from "node:test";
import assert from "node:assert/strict";
import { report } from "../src/report.ts";
import { receiptFooter } from "../src/receipt.ts";

test("report lists lines and the total", () => {
  const text = report([
    { description: "Tea", cents: 250, qty: 2 },
    { description: "Cake", cents: 750, qty: 1 },
  ]);
  assert.equal(text, "Tea x2: €5.00\nCake x1: €7.50\nTotal: €12.50");
});

test("receipt footer shows change", () => {
  assert.equal(receiptFooter(2000, 1250), "Paid €20.00, change €7.50");
});
