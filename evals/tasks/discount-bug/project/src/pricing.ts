export type Code =
  | { type: "percent"; value: number }
  | { type: "fixed"; cents: number }
  | { type: "shipping" };

export const CODES: Record<string, Code> = {
  SAVE10: { type: "percent", value: 10 },
  SAVE15: { type: "percent", value: 15 },
  FIVEOFF: { type: "fixed", cents: 500 },
  FREESHIP: { type: "shipping" },
};

/** Price of one item after applying a discount code. */
export function applyDiscount(cents: number, code?: string): number {
  if (!code) return cents;
  const discount = CODES[code];
  if (!discount) throw new Error(`Unknown discount code: ${code}`);
  switch (discount.type) {
    case "percent":
      return Math.ceil((cents * (100 - discount.value)) / 100);
    case "fixed":
      return cents - discount.cents;
    case "shipping":
      return 0;
  }
}
