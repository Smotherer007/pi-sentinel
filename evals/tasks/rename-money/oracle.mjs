// Hidden acceptance checks. Run with cwd = the finished workspace.
import { check, finish, grepFiles, importTs, readText } from "../../oracle-kit.mjs";

await check("no formatCents left in src/ or test/", () => grepFiles(["src", "test"], /formatCents/).length === 0, () => grepFiles(["src", "test"], /formatCents/).join(", "));
const money = await importTs("src/money.ts");
await check("formatMoney(1250) === '€12.50'", () => money.formatMoney(1250) === "€12.50", () => money.formatMoney?.(1250));
await check("formatMoney(1250, 'EUR') === '€12.50'", () => money.formatMoney(1250, "EUR") === "€12.50", () => money.formatMoney?.(1250, "EUR"));
await check("formatMoney(1250, 'USD') === '$12.50'", () => money.formatMoney(1250, "USD") === "$12.50", () => money.formatMoney?.(1250, "USD"));
await check("formatMoney(1250, 'CHF') === '12.50 CHF'", () => money.formatMoney(1250, "CHF") === "12.50 CHF", () => money.formatMoney?.(1250, "CHF"));
const report = await importTs("src/report.ts");
await check("report output unchanged", () =>
  report.report([{ description: "Tea", cents: 250, qty: 2 }, { description: "Cake", cents: 750, qty: 1 }]) === "Tea x2: €5.00\nCake x1: €7.50\nTotal: €12.50");
const receipt = await importTs("src/receipt.ts");
await check("receipt output unchanged", () => receipt.receiptFooter(1000, 1250) === "Still due: €2.50", () => receipt.receiptFooter?.(1000, 1250));
await check("original test assertions still present", () => readText("test/report.test.ts").includes('"Tea x2: €5.00\\nCake x1: €7.50\\nTotal: €12.50"'));
finish();
