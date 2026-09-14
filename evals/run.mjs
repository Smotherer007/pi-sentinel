/**
 * Eval runner — what sentinel did, on trajectories whose outcome is known.
 *
 * The unit tests say the mechanisms do what they were built for. This says what
 * they *cost*, in the numbers the README promises:
 *
 *   interventions  actions sentinel took on its own (injections, rollbacks)
 *   attempts       bounded repair attempts spent
 *   nuisance        verdicts that were obsolete when they were read
 *   false alarms   red verdicts that passed again on the same content
 *   recovered      a red turn the loop closed with a green one
 *
 * Every trajectory runs twice: with sentinel and with `enabled: false`. A count
 * without its baseline says nothing, and the baseline is also how "the fixture
 * ended broken" becomes visible.
 *
 * The honest limitation, stated in `evals/README.md` and repeated in the report:
 * the agent here is *scripted*. It proves sentinel noticed, intervened and
 * stayed quiet exactly when it should — it does not prove a real agent writes
 * better code with sentinel installed. That needs the model-in-the-loop run,
 * which is the next slice.
 *
 * Usage: `node evals/run.mjs [--task <id>]`
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { createFakeCtx, createFakePi, turn } from "./harness.mjs";

const REPO = new URL("..", import.meta.url).pathname;
const FIXTURES = path.join(REPO, "evals", "fixtures");

/**
 * The trajectories. Each step is an edit; `rel: null` is a turn with no change.
 *
 * The fixtures start green, so a red verdict always traces back to a step in the
 * trajectory — never to the fixture's own starting state.
 */
const TASKS = [
  {
    id: "0001-off-by-one",
    title: "fix a latent off-by-one, then break the covered guard, then repair it",
    /** What the runner re-runs to test whether a red verdict reproduces. */
    check: { cmd: "npm test" },
    config: {
      // Explicit, not inherited: with `autoRollback` on (the library default) a red
      // turn restores the file, and then "did the agent's second edit fix it?" can
      // no longer be answered — the rollback did. This trajectory measures the
      // repair loop; a rollback column belongs to a task of its own.
      autoRollback: false,
      backgroundTurnEnd: false,
      pipelines: {
        onFileMutation: [],
        onTurnEnd: [{ name: "unit-tests", cmd: "npm test", timeoutMs: 60_000, cacheable: false }],
      },
    },
    trajectories: [
      {
        name: "honest fix",
        note: "the agent fixes the latent off-by-one; the shipped check does not cover it, so the turn stays green",
        // The guard must stay out of the way when nothing is wrong: no
        // intervention, no attempt, no verdict to demote.
        expect: { reds: 0, interventions: 0, attempts: 0, nuisance: 0, falseAlarms: 0, recovered: 0, fixtureGreen: true },
        steps: [
          {
            rel: "src/sum.js",
            content: `export function sum(values) {
  if (!Array.isArray(values)) throw new Error("sum expects an array");
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}
`,
          },
        ],
      },
      {
        name: "breaks it, then repairs",
        note: "an edit drops the argument guard the check covers, then a second edit restores it",
        // One real failure, one attempt spent, the loop closed by the repair —
        // and no false alarm, which is what the re-run above decides.
        expect: { reds: 1, interventions: 1, attempts: 1, nuisance: 0, falseAlarms: 0, recovered: 1, fixtureGreen: true },
        steps: [
          {
            rel: "src/sum.js",
            content: `export function sum(values) {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}
`,
          },
          {
            rel: "src/sum.js",
            content: `export function sum(values) {
  if (!Array.isArray(values)) throw new Error("sum expects an array");
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}
`,
          },
        ],
      },
    ],
  },
];

/** Copy the fixture into a fresh project, committed, so out-of-band detection has a baseline. */
function prepareProject(fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-eval-"));
  fs.cpSync(path.join(FIXTURES, fixture), dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=e@e", "-c", "user.name=e", "commit", "-qm", "fixture"], {
    cwd: dir,
  });
  return dir;
}

/** Run one trajectory and collect what sentinel did. */
async function runTrajectory(task, trajectory, { enabled }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-eval-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const extensionFactory = (await import(new URL("../index.ts", import.meta.url).href)).default;
    const { createRuntime } = await import(new URL("../src/runtime.ts", import.meta.url).href);

    const project = prepareProject(task.id);
    const runtime = createRuntime();
    const fake = createFakePi();
    const ctx = createFakeCtx(project);
    extensionFactory(fake.api, { runtime });

    // A project config, written like a person would: the eval measures sentinel,
    // not the config resolver. The baseline run keeps the file and only turns the
    // guard off, so both runs share everything but sentinel.
    fs.writeFileSync(
      path.join(project, "sentinel.config.js"),
      `export default ${JSON.stringify({ ...task.config, enabled }, null, 2)};\n`,
    );

    await fake.fire("session_start", { type: "session_start" }, ctx);
    // Track false alarms where they can actually be measured: right after a red
    // verdict, re-run the step's own command over the content it just judged. If
    // it passes now, that verdict was not reproducible — a false alarm (or a
    // flake, which is the same thing seen from here). Reading this off the
    // verdict list later would have needed a state hash the history does not
    // keep, and would have counted recoveries as false alarms.
    const [program, ...args] = task.check.cmd.split(" ");
    let falseAlarms = 0;
    let index = 1;
    for (const step of trajectory.steps) {
      await turn(fake, ctx, index, step.rel, step.content, `call-${index}`);
      const last = runtime.config.state().lastVerifications[0];
      if (last && !last.passed && last.step) {
        try {
          execFileSync(program, args, { cwd: project, stdio: "pipe" });
          falseAlarms += 1;
        } catch {
          /* the failure reproduced: the verdict was true */
        }
      }
      index += 1;
    }

    const state = runtime.config.state();
    // Newest first: `recordTurnOutcome` and `recordVerifications` push the newest
    // to the front, so chronological order is the reverse. Getting this wrong once
    // made `recovered` always zero while the table still looked plausible.
    const verdicts = [...state.lastVerifications].reverse();
    const turnHistory = [...state.turnHistory].reverse();
    const injections = fake.sent.filter(
      (entry) => entry.message?.details?.attempt !== undefined,
    );
    const interventions = injections.length + state.rollbackHistory.length;
    const attempts = state.autoFixHistory
      .filter((entry) => entry.outcome === "injected")
      .reduce((max, entry) => Math.max(max, entry.attempt ?? 0), 0);
    const nuisance = state.autoFixHistory.filter((entry) => entry.outcome === "superseded").length;
    const reds = turnHistory.filter((entry) => !entry.passed).length;
    // The loop closed: a green turn that follows a red one.
    const recovered = turnHistory.some(
      (entry, i) => i > 0 && !turnHistory[i - 1].passed && entry.passed,
    )
      ? 1
      : 0;

    // What the fixture looks like at the end, measured independently of sentinel.
    let fixtureGreen;
    try {
      execFileSync("npm", ["test"], { cwd: project, stdio: "pipe" });
      fixtureGreen = true;
    } catch {
      fixtureGreen = false;
    }

    return {
      interventions,
      attempts,
      nuisance,
      falseAlarms,
      reds,
      recovered,
      fixtureGreen,
      redVerdicts: verdicts.filter((entry) => !entry.passed).map((entry) => entry.step),
      /** Raw material for `--verbose`: what sentinel actually sent, and why. */
      audit: {
        sent: fake.sent.map((entry) => entry.message?.details ?? {}),
        autoFix: state.autoFixHistory.map((entry) => `${entry.outcome}:${entry.reason}`),
        turns: turnHistory.map((entry) => (entry.passed ? "green" : `red:${entry.step}`)),
        verdicts: verdicts.map((entry) => (entry.passed ? "green" : `red:${entry.step}`)),
      },
    };
  } finally {
    process.env.HOME = previousHome;
  }
}

const filter = process.argv.indexOf("--task");
const wanted = filter >= 0 ? process.argv[filter + 1] : null;
const verbose = process.argv.includes("--verbose");
const tasks = wanted ? TASKS.filter((task) => task.id === wanted) : TASKS;

const rows = [];
let failures = 0;
for (const task of tasks) {
  for (const trajectory of task.trajectories) {
    const withSentinel = await runTrajectory(task, trajectory, { enabled: true });
    const without = await runTrajectory(task, trajectory, { enabled: false });
    // The expectation is compared against the *guarded* run: it describes what
    // sentinel should do. `off` is the baseline it is read against.
    const mismatched = Object.entries(trajectory.expect).filter(
      ([key, value]) => withSentinel[key] !== value,
    );
    if (mismatched.length > 0) failures += 1;
    rows.push({
      task: task.id,
      trajectory: trajectory.name,
      withSentinel,
      without,
      mismatched: mismatched.map(([key, value]) => `${key}=${withSentinel[key]} (expected ${value})`),
    });
  }
}

const header = ["task / trajectory", "guard", "interv", "attmpt", "nuis", "false", "reds", "recov", "fixture", "expect"];
const table = [header];
for (const row of rows) {
  for (const [guard, data] of [
    ["on", row.withSentinel],
    ["off", row.without],
  ]) {
    table.push([
      guard === "on" ? `${row.task}\n  ${row.trajectory}` : "",
      guard,
      String(data.interventions),
      String(data.attempts),
      String(data.nuisance),
      String(data.falseAlarms),
      String(data.reds),
      String(data.recovered),
      data.fixtureGreen ? "green" : "BROKEN",
      guard === "on" ? (row.mismatched.length === 0 ? "ok" : `MISMATCH: ${row.mismatched.join(", ")}`) : "",
    ]);
  }
}

const widths = header.map((_, column) =>
  Math.max(...table.map((line) => String(line[column]).split("\n").reduce((max, part) => Math.max(max, part.length), 0))),
);
for (const line of table) {
  const cells = line.map((cell) => String(cell).split("\n"));
  for (let row = 0; row < Math.max(...cells.map((cell) => cell.length)); row += 1) {
    console.log(
      cells
        .map((cell, column) => (cell[row] ?? "").padEnd(widths[column]))
        .join("  ")
        .trimEnd(),
    );
  }
}

console.log(`
Guard "off" is the same trajectory with \`enabled: false\`: it is what the numbers are read against.
The agent here is *scripted* — this measures what sentinel did, not whether a real agent writes
better code with it. That run is the next slice.`);

if (failures > 0) {
  console.error(`\n${failures} trajectory/trajectories did not match their expectation.`);
  process.exit(1);
}

if (verbose) {
  for (const row of rows) {
    console.log(`\n── ${row.task} / ${row.trajectory} ──`);
    for (const [guard, data] of [
      ["on", row.withSentinel],
      ["off", row.without],
    ]) {
      console.log(`  guard ${guard}:`);
      console.log(`    turns:     ${data.audit.turns.join(" → ") || "(none)"}`);
      console.log(`    verdicts:  ${data.audit.verdicts.join(" → ") || "(none)"}`);
      console.log(`    autoFix:   ${data.audit.autoFix.join(" | ") || "(none)"}`);
      console.log(`    sent:      ${data.audit.sent.map((d) => d.step ?? d.resolved ?? "?").join(", ") || "(none)"}`);
    }
  }
}
