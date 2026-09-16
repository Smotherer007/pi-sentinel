import { formatCents } from "./money.ts";

export function receiptFooter(paidCents: number, dueCents: number): string {
  const change = paidCents - dueCents;
  return change >= 0 ? `Paid ${formatCents(paidCents)}, change ${formatCents(change)}` : `Still due: ${formatCents(-change)}`;
}
