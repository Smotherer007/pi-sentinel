import { check, finish, importTs } from "../../oracle-kit.mjs";

const p = await importTs("src/pricing.ts");
const c = await importTs("src/cart.ts");
await check("SAVE15 on 999 -> 849", () => p.applyDiscount(999, "SAVE15") === 849, () => p.applyDiscount?.(999, "SAVE15"));
await check("SAVE10 on 999 -> 899", () => p.applyDiscount(999, "SAVE10") === 899, () => p.applyDiscount?.(999, "SAVE10"));
await check("SAVE10 on 1000 -> 900", () => p.applyDiscount(1000, "SAVE10") === 900);
await check("FIVEOFF on 300 -> 0", () => p.applyDiscount(300, "FIVEOFF") === 0, () => p.applyDiscount?.(300, "FIVEOFF"));
await check("FIVEOFF on 1200 -> 700", () => p.applyDiscount(1200, "FIVEOFF") === 700);
await check("FREESHIP keeps item price", () => p.applyDiscount(1000, "FREESHIP") === 1000, () => p.applyDiscount?.(1000, "FREESHIP"));
await check("cart with FREESHIP = goods only", () => c.cartTotal([{ cents: 1000, qty: 2 }], "FREESHIP") === 2000, () => c.cartTotal?.([{ cents: 1000, qty: 2 }], "FREESHIP"));
await check("cart without code includes shipping", () => c.cartTotal([{ cents: 1000, qty: 2 }]) === 2490);
await check("unknown code throws", () => {
  try {
    p.applyDiscount(1000, "NOPE");
    return false;
  } catch {
    return true;
  }
});
finish();
