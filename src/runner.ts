/**
 * Runs check commands.
 *
 * Each step runs through the platform shell in its own process group, with a
 * hard deadline that kills the whole tree (SIGTERM, then SIGKILL), a bounded
 * output buffer and secret redaction — everything here ends up in the model's
 * context.
 */

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as path from "node:path";

import { classifyFailure } from "./format/classify.ts";
import { redactSecrets } from "./format/redact.ts";
import { matchesAny, relativeTo } from "./glob.ts";
import { DEFAULT_TIMEOUT_MS } from "./config.ts";
import type { CheckRun, FailureKind, Step, StepResult } from "./types.ts";

export const MAX_OUTPUT_BYTES = 256 * 1024;
const KILL_GRACE_MS = 1_000;
const MAX_TIMER_MS = 2_147_483_647;

/** Failures that say nothing about the code. They never trigger a repair. */
export const INFRASTRUCTURE_KINDS: ReadonlySet<FailureKind> = new Set(["timeout", "command-not-found", "environment-error"]);

export function isInfrastructureFailure(result: StepResult | undefined): boolean {
  return result?.kind !== undefined && INFRASTRUCTURE_KINDS.has(result.kind);
}

export interface RunOptions {
  cwd: string;
  /** Files that changed; steps with a `files` filter only run when one matches. */
  changed?: string[];
  signal?: AbortSignal;
}

export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* fall through */
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

function stepCwd(base: string, step: Step): string | null {
  if (!step.cwd) return base;
  const target = path.resolve(base, step.cwd);
  const rel = path.relative(path.resolve(base), target);
  return rel.startsWith("..") || path.isAbsolute(rel) ? null : target;
}

export function stepApplies(step: Step, cwd: string, changed: string[] | undefined): boolean {
  if (!step.files || step.files.length === 0 || changed === undefined) return true;
  return changed.some((file) => matchesAny(step.files!, relativeTo(cwd, file)));
}

/** Run a single command. Never rejects. */
export function runStep(step: Step, options: RunOptions): Promise<StepResult> {
  const startedAt = Date.now();
  const base = { name: step.name, cmd: step.cmd, warnOnly: step.warnOnly === true };
  const done = (exitCode: number, output: string, timedOut = false, aborted = false): StepResult => {
    const passed = exitCode === 0;
    return {
      ...base,
      passed,
      exitCode,
      output,
      timedOut,
      durationMs: Date.now() - startedAt,
      // An aborted run says nothing about the code.
      kind: passed ? undefined : aborted ? "environment-error" : classifyFailure({ stepName: step.name, cmd: step.cmd, exitCode, timedOut, output }),
    };
  };

  const timeoutMs = step.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve({ ...done(1, `[sentinel] ${step.name}: invalid timeoutMs`), kind: "environment-error" });
  }
  const cwd = stepCwd(options.cwd, step);
  if (!cwd) {
    return Promise.resolve({ ...done(1, `[sentinel] ${step.name}: cwd escapes the project root`), kind: "environment-error" });
  }
  if (options.signal?.aborted) return Promise.resolve({ ...done(130, "aborted"), kind: "environment-error" });

  return new Promise((resolve) => {
    const env = { ...process.env, FORCE_COLOR: "0", ...step.env };
    const child = spawn(step.cmd, {
      cwd,
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let output = "";
    let settled = false;
    const push = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > MAX_OUTPUT_BYTES) {
        const half = Math.floor(MAX_OUTPUT_BYTES / 2);
        output = `${output.slice(0, half)}\n… [output truncated] …\n${output.slice(-half)}`;
      }
    };
    child.stdout?.on("data", push);
    child.stderr?.on("data", push);

    const finish = (exitCode: number, note = "", timedOut = false, aborted = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const text = redactSecrets([output.trim(), note].filter(Boolean).join("\n"), env);
      resolve(done(exitCode, text, timedOut, aborted));
    };
    const terminate = () => {
      killTree(child, "SIGTERM");
      setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
    };
    const onAbort = () => {
      terminate();
      finish(130, `${step.name}: aborted`, false, true);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      terminate();
      finish(124, `${step.name}: timed out after ${timeoutMs}ms`, true);
    }, Math.min(timeoutMs, MAX_TIMER_MS));

    child.on("close", (code, signal) => finish(code ?? (signal ? 128 : 1)));
    child.on("error", (err) => finish(127, `${step.name}: ${err.message}`));
  });
}

/**
 * Run steps in order. A blocking failure stops the run — later steps would
 * mostly report consequences of the first error.
 */
export async function runChecks(steps: Step[], options: RunOptions): Promise<CheckRun> {
  const results: StepResult[] = [];
  const warnings: StepResult[] = [];
  for (const step of steps) {
    if (!stepApplies(step, options.cwd, options.changed)) {
      results.push({
        name: step.name,
        cmd: step.cmd,
        passed: true,
        exitCode: 0,
        durationMs: 0,
        output: "",
        warnOnly: step.warnOnly === true,
        timedOut: false,
        skipped: "no matching files changed",
      });
      continue;
    }
    const result = await runStep(step, options);
    results.push(result);
    if (result.passed) continue;
    if (result.warnOnly) {
      warnings.push(result);
      continue;
    }
    return { passed: false, steps: results, failure: result, warnings };
  }
  return { passed: true, steps: results, warnings };
}

/** Whether a run actually executed anything (all-skipped proves nothing). */
export function ranAnything(run: CheckRun): boolean {
  return run.steps.some((step) => !step.skipped);
}
