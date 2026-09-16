import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDiscount } from "../src/pricing.ts";
import { cartTotal } from "../src/cart.ts";

test("SAVE10 takes 10% off", () => {
  assert.equal(applyDiscount(1000, "SAVE10"), 900);
});

test("no code, no discount", () => {
  assert.equal(cartTotal([{ cents: 1000, qty: 2 }]), 2490);
});
