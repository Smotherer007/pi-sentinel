import { formatCents } from "./money.ts";
import { totalLabel, type Line } from "./invoice.ts";

export function report(lines: Line[]): string {
  const rows = lines.map((line) => `${line.description} x${line.qty}: ${formatCents(line.cents * line.qty)}`);
  return [...rows, `Total: ${totalLabel(lines)}`].join("\n");
}
