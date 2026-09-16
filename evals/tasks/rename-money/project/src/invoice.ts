import { formatCents } from "./money.ts";

export interface Line {
  description: string;
  cents: number;
  qty: number;
}

export function totalCents(lines: Line[]): number {
  return lines.reduce((sum, line) => sum + line.cents * line.qty, 0);
}

export function totalLabel(lines: Line[]): string {
  return formatCents(totalCents(lines));
}
