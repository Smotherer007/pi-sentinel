import { check, finish, importTs } from "../../oracle-kit.mjs";

const d = await importTs("src/duration.ts");
const cli = await importTs("src/cli.ts");
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};
for (const [input, seconds] of [["45s", 45], ["15m", 900], ["2h", 7200], ["1h30m", 5400], ["1m30s", 90], ["90", 90], ["1h0m5s", 3605]]) {
  await check(`parseDuration(${JSON.stringify(input)}) === ${seconds}`, () => d.parseDuration(input) === seconds, () => d.parseDuration?.(input));
}
for (const input of ["", "abc", "1x", "m5"]) {
  await check(`parseDuration(${JSON.stringify(input)}) throws`, () => typeof d.parseDuration === "function" && throws(() => d.parseDuration(input)));
}
await check("--timeout 1h30m -> 5400", () => cli.parseArgs(["--timeout", "1h30m"]).timeout === 5400, () => cli.parseArgs?.(["--timeout", "1h30m"]).timeout);
await check("--timeout 90 -> 90", () => cli.parseArgs(["--timeout", "90"]).timeout === 90);
await check("defaults unchanged", () => cli.describe(cli.parseArgs([])) === "retries=3 timeout=10m");
await check("invalid --timeout throws", () => throws(() => cli.parseArgs(["--timeout", "soon"])));
finish();
