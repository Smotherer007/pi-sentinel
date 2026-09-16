#!/usr/bin/env node
/**
 * Compare pi with and without pi-sentinel on real tasks, with a real model.
 *
 *   node evals/compare.mjs --model <pattern> [--provider <name>] [--repeats 2]
 *
 * For every task × variant × repeat:
 *   1. copy the task's project into a fresh temp workspace (git repo, shared node_modules)
 *   2. run `pi -p --mode json` with the task prompt — only the variant's extensions load (-ne)
 *   3. run the hidden oracle (checks the agent never sees), the project's tests and typecheck
 *   4. write everything to evals/runs/<stamp>/<task>/<variant>-<n>/
 *
 * Output per run: events.jsonl (full pi event stream), stderr.log, diff.patch, oracle.json,
 * final-checks.json, run.json (metrics). Top level: summary.json and summary.md.
 *
 * Options:
 *   --model <pattern>        model passed to pi (default: pi's configured default)
 *   --provider <name>        provider passed to pi
 *   --thinking <level>       appended as --thinking if given
 *   --tasks a,b              subset of evals/tasks (default: all)
 *   --variants a,b           baseline, sentinel, mindplace, sentinel+mindplace (default: baseline,sentinel)
 *   --repeats <n>            runs per task and variant (default: 1)
 *   --parallel <n>           concurrent runs (default: 1)
 *   --timeout-min <n>        per run (default: 15)
 *   --pi <path>              pi binary (default: `pi` on PATH, else node_modules/.bin/pi)
 *   --mindplace <path>       path to pi-mindplace's index.ts (needed for the mindplace variants)
 *   --extension <path>       extra extension for every variant (repeatable; used for offline smoke tests)
 *   --out <dir>              output directory (default: evals/runs/<timestamp>)
 *   --keep                   keep the temp workspaces
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const EVALS = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(EVALS, "..");

// ── arguments ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { variants: ["baseline", "sentinel"], repeats: 1, parallel: 1, timeoutMin: 15, extensions: [], keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--model") opts.model = next();
    else if (arg === "--provider") opts.provider = next();
    else if (arg === "--thinking") opts.thinking = next();
    else if (arg === "--tasks") opts.tasks = next().split(",").filter(Boolean);
    else if (arg === "--variants") opts.variants = next().split(",").filter(Boolean);
    else if (arg === "--repeats") opts.repeats = Math.max(1, Number(next()));
    else if (arg === "--parallel") opts.parallel = Math.max(1, Number(next()));
    else if (arg === "--timeout-min") opts.timeoutMin = Number(next());
    else if (arg === "--pi") opts.pi = next();
    else if (arg === "--mindplace") opts.mindplace = path.resolve(next());
    else if (arg === "--extension") opts.extensions.push(path.resolve(next()));
    else if (arg === "--out") opts.out = path.resolve(next());
    else if (arg === "--keep") opts.keep = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf-8").split("*/")[0]);
      process.exit(0);
    } else throw new Error(`unknown option ${arg}`);
  }
  return opts;
}

function findPi(explicit) {
  if (explicit) return explicit;
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["pi"], { encoding: "utf-8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim().split("\n")[0];
  const local = path.join(REPO, "node_modules", ".bin", "pi");
  if (fs.existsSync(local)) return local;
  throw new Error("pi not found: install it or pass --pi <path>");
}

function variantExtensions(variant, opts) {
  const sentinel = path.join(REPO, "index.ts");
  const needMindplace = () => {
    if (!opts.mindplace) throw new Error(`variant "${variant}" needs --mindplace <path to pi-mindplace/index.ts>`);
    return opts.mindplace;
  };
  switch (variant) {
    case "baseline":
      return [];
    case "sentinel":
      return [sentinel];
    case "mindplace":
      return [needMindplace()];
    case "sentinel+mindplace":
      return [needMindplace(), sentinel];
    default:
      throw new Error(`unknown variant ${variant}`);
  }
}

// ── workspace ─────────────────────────────────────────────────────────────

/** One shared install of the fixtures' dev dependencies, symlinked into every workspace. */
function ensureDependencies() {
  const cache = path.join(EVALS, ".cache");
  if (fs.existsSync(path.join(cache, "node_modules", "typescript"))) return path.join(cache, "node_modules");
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, "package.json"), JSON.stringify({ private: true, devDependencies: { typescript: "^5.6.0", "@types/node": "^22.0.0" } }, null, 2));
  console.log("installing fixture dependencies (once)…");
  execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: cache, stdio: "inherit" });
  return path.join(cache, "node_modules");
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

function createWorkspace(task, label, nodeModules) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-eval-${task.id}-${label}-`));
  fs.cpSync(path.join(task.dir, "project"), dir, { recursive: true });
  fs.symlinkSync(nodeModules, path.join(dir, "node_modules"), "dir");
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=eval", "-c", "user.email=eval@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "task start");
  return dir;
}

// ── running ───────────────────────────────────────────────────────────────

function runPi({ pi, cwd, args, logDir, timeoutMs }) {
  return new Promise((resolve) => {
    const out = fs.openSync(path.join(logDir, "events.jsonl"), "w");
    const err = fs.openSync(path.join(logDir, "stderr.log"), "w");
    const started = Date.now();
    const child = spawn(pi, args, { cwd, stdio: ["ignore", out, err], detached: process.platform !== "win32", env: process.env });
    let timedOut = false;
    const kill = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* gone */
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 5_000);
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      fs.closeSync(out);
      fs.closeSync(err);
      resolve({ exitCode: code, signal, timedOut, durationMs: Date.now() - started });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, error: error.message, timedOut, durationMs: Date.now() - started });
    });
  });
}

function runCommand(cwd, cmd, args, timeoutMs = 300_000) {
  const started = Date.now();
  const result = spawnSync(cmd, args, { cwd, encoding: "utf-8", timeout: timeoutMs, env: { ...process.env, FORCE_COLOR: "0" } });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { passed: result.status === 0, exitCode: result.status, durationMs: Date.now() - started, tail: output.split("\n").slice(-40).join("\n") };
}

// ── analysis ──────────────────────────────────────────────────────────────

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block?.text ?? "").join("");
}

function analyseEvents(file) {
  const stats = {
    events: 0,
    unparsedLines: 0,
    agentRuns: 0,
    assistantMessages: 0,
    toolCalls: {},
    toolErrors: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    stopReasons: {},
    errors: [],
    sentinel: { repairPrompts: 0, stopNotices: 0, editHints: 0, messages: [] },
    finalText: "",
  };
  let lines = [];
  try {
    lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
  } catch {
    return stats;
  }
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      stats.unparsedLines += 1;
      continue;
    }
    stats.events += 1;
    if (event.type === "agent_start") stats.agentRuns += 1;
    if (event.type !== "message_end" || !event.message) continue;
    const message = event.message;
    if (message.role === "assistant") {
      stats.assistantMessages += 1;
      const usage = message.usage ?? {};
      for (const key of ["input", "output", "cacheRead", "cacheWrite"]) stats.tokens[key] += usage[key] ?? 0;
      stats.tokens.total += usage.totalTokens ?? 0;
      stats.cost += usage.cost?.total ?? 0;
      stats.stopReasons[message.stopReason] = (stats.stopReasons[message.stopReason] ?? 0) + 1;
      if (message.errorMessage) stats.errors.push(message.errorMessage);
      for (const block of message.content ?? []) {
        if (block?.type === "toolCall") stats.toolCalls[block.name] = (stats.toolCalls[block.name] ?? 0) + 1;
      }
      const text = textOf(message.content);
      if (text.trim()) stats.finalText = text.trim();
    } else if (message.role === "toolResult") {
      if (message.isError) stats.toolErrors += 1;
      if (textOf(message.content).includes("[sentinel]")) stats.sentinel.editHints += 1;
    } else if (message.role === "custom" && message.customType === "sentinel") {
      const kind = message.details?.kind;
      if (kind === "repair") stats.sentinel.repairPrompts += 1;
      if (kind === "stopped") stats.sentinel.stopNotices += 1;
      stats.sentinel.messages.push({ kind, text: textOf(message.content).slice(0, 4000) });
    }
  }
  stats.finalText = stats.finalText.slice(0, 2000);
  return stats;
}

async function runOne({ task, variant, repeat, opts, pi, nodeModules, outDir }) {
  const label = `${variant.replace("+", "-")}-${repeat}`;
  const logDir = path.join(outDir, task.id, label);
  fs.mkdirSync(logDir, { recursive: true });
  const workdir = createWorkspace(task, label, nodeModules);

  const args = ["-p", "--mode", "json", "--no-session", "-ne"];
  if (opts.provider) args.push("--provider", opts.provider);
  if (opts.model) args.push("--model", opts.model);
  if (opts.thinking) args.push("--thinking", opts.thinking);
  for (const ext of [...opts.extensions, ...variantExtensions(variant, opts)]) args.push("-e", ext);
  args.push(task.prompt);

  console.log(`▶ ${task.id} · ${variant} · #${repeat}`);
  const pRun = await runPi({ pi, cwd: workdir, args, logDir, timeoutMs: opts.timeoutMin * 60_000 });

  const oracleRun = spawnSync(process.execPath, [path.join(task.dir, "oracle.mjs")], { cwd: workdir, encoding: "utf-8", timeout: 120_000 });
  let oracle;
  try {
    oracle = JSON.parse(oracleRun.stdout);
  } catch {
    oracle = { passed: false, total: 0, failed: 0, checks: [], error: `${oracleRun.stdout}\n${oracleRun.stderr}`.slice(0, 2000) };
  }
  const final = { typecheck: runCommand(workdir, "npm", ["run", "typecheck"]), test: runCommand(workdir, "npm", ["test"]) };

  git(workdir, "add", "-A");
  const diff = git(workdir, "diff", "--cached", "HEAD");
  const changedFiles = git(workdir, "diff", "--cached", "--name-only", "HEAD").split("\n").filter(Boolean);
  const testFilesChanged = changedFiles.filter((f) => f.startsWith("test/"));
  fs.writeFileSync(path.join(logDir, "diff.patch"), diff);
  fs.writeFileSync(path.join(logDir, "oracle.json"), JSON.stringify(oracle, null, 2));
  fs.writeFileSync(path.join(logDir, "final-checks.json"), JSON.stringify(final, null, 2));

  const events = analyseEvents(path.join(logDir, "events.jsonl"));
  const record = {
    task: task.id,
    kind: task.kind,
    variant,
    repeat,
    model: opts.model ?? "(pi default)",
    provider: opts.provider ?? "(pi default)",
    pi: { ...pRun },
    oracle: { passed: oracle.passed, total: oracle.total, failed: oracle.failed },
    final: { typecheck: final.typecheck.passed, test: final.test.passed },
    changedFiles,
    testFilesChanged,
    diffLines: diff.split("\n").filter((l) => /^[+-](?![+-])/.test(l)).length,
    events: { ...events, sentinel: { ...events.sentinel, messages: undefined } },
    workdir: opts.keep ? workdir : undefined,
  };
  fs.writeFileSync(path.join(logDir, "run.json"), JSON.stringify({ ...record, sentinelMessages: events.sentinel.messages, oracleChecks: oracle.checks }, null, 2));
  if (!opts.keep) fs.rmSync(workdir, { recursive: true, force: true });

  const mark = oracle.passed ? "✓" : "✗";
  console.log(
    `  ${mark} oracle ${oracle.total - oracle.failed}/${oracle.total} · tests ${final.test.passed ? "green" : "red"} · tsc ${final.typecheck.passed ? "green" : "red"} · ` +
      `${(pRun.durationMs / 1000).toFixed(0)}s · ${events.assistantMessages} model calls · ${events.tokens.total} tokens · repairs ${events.sentinel.repairPrompts}` +
      (pRun.timedOut ? " · TIMEOUT" : "") +
      (events.errors.length ? ` · errors: ${events.errors.length}` : ""),
  );
  return record;
}

// ── summary ───────────────────────────────────────────────────────────────

function summarise(records, opts, pi, startedAt) {
  const groups = new Map();
  for (const r of records) {
    const key = `${r.task}\u0000${r.variant}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const rows = [...groups.values()].map((runs) => ({
    task: runs[0].task,
    variant: runs[0].variant,
    runs: runs.length,
    oraclePassRate: avg(runs.map((r) => (r.oracle.passed ? 1 : 0))),
    oracleChecksPassed: avg(runs.map((r) => (r.oracle.total ? (r.oracle.total - r.oracle.failed) / r.oracle.total : 0))),
    testsGreenRate: avg(runs.map((r) => (r.final.test ? 1 : 0))),
    typecheckGreenRate: avg(runs.map((r) => (r.final.typecheck ? 1 : 0))),
    avgDurationS: avg(runs.map((r) => r.pi.durationMs / 1000)),
    avgModelCalls: avg(runs.map((r) => r.events.assistantMessages)),
    avgTokens: avg(runs.map((r) => r.events.tokens.total)),
    avgCost: avg(runs.map((r) => r.events.cost)),
    avgRepairPrompts: avg(runs.map((r) => r.events.sentinel.repairPrompts)),
    avgEditHints: avg(runs.map((r) => r.events.sentinel.editHints)),
    timeouts: runs.filter((r) => r.pi.timedOut).length,
    errors: runs.reduce((n, r) => n + r.events.errors.length, 0),
  }));

  const pct = (x) => `${Math.round(x * 100)}%`;
  const md = [
    `# pi-sentinel comparison — ${startedAt}`,
    "",
    `model: ${opts.model ?? "(pi default)"} · provider: ${opts.provider ?? "(pi default)"} · repeats: ${opts.repeats} · pi: ${pi}`,
    "",
    "| task | variant | runs | oracle pass | oracle checks | tests green | tsc green | avg time | model calls | tokens | cost | repairs | edit hints | timeouts/errors |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.task} | ${r.variant} | ${r.runs} | ${pct(r.oraclePassRate)} | ${pct(r.oracleChecksPassed)} | ${pct(r.testsGreenRate)} | ${pct(r.typecheckGreenRate)} | ${r.avgDurationS.toFixed(0)}s | ${r.avgModelCalls.toFixed(1)} | ${Math.round(r.avgTokens)} | $${r.avgCost.toFixed(3)} | ${r.avgRepairPrompts.toFixed(1)} | ${r.avgEditHints.toFixed(1)} | ${r.timeouts}/${r.errors} |`,
    ),
    "",
    "Oracle = hidden acceptance checks the agent never sees. Per-run details: `<task>/<variant>-<n>/run.json`, full event stream in `events.jsonl`.",
  ].join("\n");
  return { rows, md };
}

// ── main ──────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pi = findPi(opts.pi);
  const startedAt = new Date().toISOString();
  const outDir = opts.out ?? path.join(EVALS, "runs", startedAt.replace(/[:.]/g, "-"));
  fs.mkdirSync(outDir, { recursive: true });

  const allTasks = fs
    .readdirSync(path.join(EVALS, "tasks"))
    .filter((id) => fs.existsSync(path.join(EVALS, "tasks", id, "task.json")))
    .map((id) => ({ ...JSON.parse(fs.readFileSync(path.join(EVALS, "tasks", id, "task.json"), "utf-8")), dir: path.join(EVALS, "tasks", id) }));
  const tasks = opts.tasks ? allTasks.filter((t) => opts.tasks.includes(t.id)) : allTasks;
  if (tasks.length === 0) throw new Error("no tasks selected");
  opts.variants.forEach((v) => variantExtensions(v, opts)); // validate early

  const nodeModules = ensureDependencies();
  const piVersion = spawnSync(pi, ["--version"], { encoding: "utf-8" }).stdout?.trim();
  fs.writeFileSync(
    path.join(outDir, "meta.json"),
    JSON.stringify({ startedAt, pi, piVersion, node: process.version, platform: `${os.platform()} ${os.release()}`, opts, sentinelCommit: safeGit(REPO, "rev-parse", "HEAD"), sentinelDirty: safeGit(REPO, "status", "--porcelain") }, null, 2),
  );
  console.log(`pi ${piVersion ?? "?"} · ${tasks.length} task(s) × ${opts.variants.length} variant(s) × ${opts.repeats} · output: ${outDir}\n`);

  // Interleave variants so drift (rate limits, provider load) hits them equally.
  const jobs = [];
  for (let repeat = 1; repeat <= opts.repeats; repeat += 1) {
    for (const task of tasks) for (const variant of opts.variants) jobs.push({ task, variant, repeat });
  }

  const records = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        records.push(await runOne({ ...job, opts, pi, nodeModules, outDir }));
      } catch (err) {
        console.error(`  ! ${job.task.id} · ${job.variant} · #${job.repeat} failed: ${err.message}`);
      }
      const { rows, md } = summarise(records, opts, pi, startedAt);
      fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({ meta: { startedAt, pi, opts }, rows, records }, null, 2));
      fs.writeFileSync(path.join(outDir, "summary.md"), md);
    }
  };
  await Promise.all(Array.from({ length: opts.parallel }, worker));

  console.log(`\n${summarise(records, opts, pi, startedAt).md}\n\nLogs: ${outDir}`);
}

function safeGit(cwd, ...args) {
  try {
    return git(cwd, ...args).trim();
  } catch {
    return null;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
