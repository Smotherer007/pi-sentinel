import { applyDiscount } from "./pricing.ts";

export interface Item {
  cents: number;
  qty: number;
}

export const SHIPPING_CENTS = 490;

export function cartTotal(items: Item[], code?: string): number {
  const goods = items.reduce((sum, item) => sum + applyDiscount(item.cents, code) * item.qty, 0);
  const shipping = code === "FREESHIP" ? 0 : SHIPPING_CENTS;
  return goods + shipping;
}
