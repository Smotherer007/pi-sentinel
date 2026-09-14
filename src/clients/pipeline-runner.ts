/**
 * PipelineRunner — executes verification pipelines as subprocesses.
 *
 * This is the I/O isolation layer (parallel to pi-email's clients/).
 * Runs configured commands (`tsc`, `eslint`, `cargo check`, tests) with
 * timeouts, a bounded output buffer and structured, classified results.
 *
 * Portability: commands run through the platform shell (`shell: true`), so
 * the same config works on POSIX (`/bin/sh`) and Windows (`cmd.exe`).
 *
 * Process safety: every step runs in its own process group, and a step that
 * exceeds its timeout is terminated as a *tree* — `SIGTERM`, a short grace
 * period, then `SIGKILL`. Killing only the shell would leave `sleep`, `jest`
 * or a compiler running in the background, still burning CPU after sentinel
 * has already reported the timeout.
 *
 * Secrets: the combined output is passed through `redactSecrets` before it
 * leaves this module, because everything here ends up in the model's context.
 */

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";

import { pruneTrace, formatError } from "../formatting/pruner.ts";
import { classifyFailure, failureSignature, summarizeFailure } from "../formatting/classify.ts";
import { redactSecrets } from "../formatting/redact.ts";
import {
  getConfig,
  recordMetrics,
  recordVerifications,
  priorityOf,
  stepMatchesFiles,
  stepPhaseMatches,
} from "../config.ts";
import { getVerificationCache, createCacheKey } from "./cache.ts";
import type {
  FailureKind,
  PipelineRunResult,
  PipelineStep,
  PipelineStepResult,
  PipelineWarning,
  StepPriority,
  VerificationResult,
} from "../types.ts";

/** Fallback output budget when a caller passes a config without the field. */
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
/** Fallback SIGTERM → SIGKILL grace period. */
export const DEFAULT_KILL_GRACE_MS = 500;
/** Largest delay `setTimeout` accepts; beyond it Node silently uses 1 ms. */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * A usable output cap. A negative or non-finite value makes the head/tail math
 * grow the buffer instead of bounding it (a negative cap doubles it on every
 * chunk), so it falls back to the documented default.
 */
export function effectiveMaxOutputBytes(configured: number | undefined): number {
  if (typeof configured === "number" && Number.isFinite(configured) && configured >= 2) {
    return configured;
  }
  return DEFAULT_MAX_OUTPUT_BYTES;
}

export interface CommandOutcome {
  stdout: string;
  exitCode: number | null;
  /** Wall-clock duration of the command (including any retries). */
  durationMs: number;
  aborted?: boolean;
  timedOut?: boolean;
  /** Signal that ended the process, when it was not a plain exit. */
  signal?: string;
  /** Set when the step could not be started because of its configuration. */
  invalidConfig?: string;
}

export interface RunOptions {
  /** Abort signal from the tool/hook context; kills the running child. */
  signal?: AbortSignal;
  /** File paths just mutated — diagnostics about them are promoted. */
  focusPaths?: string[];
  /**
   * Files that actually changed, for the step `files` filter.
   *
   * Distinct from `focusPaths`, which is widened by graph dependents so their
   * diagnostics are promoted. A step that declares it only cares about `.ts`
   * files cares about what was edited, not about which neighbours were
   * recompiled. Defaults to `focusPaths`; turn-end runs pass the wider set
   * (mutations + out-of-band changes).
   */
  changedFiles?: string[];
  /** Bypass the verification cache for this run (explicit re-check). */
  skipCache?: boolean;
}

/** Terminate a child process *and everything it spawned*. */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* fall through to the direct kill below */
    }
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    return;
  }

  try {
    // Negative pid: the whole process group, which is why steps are spawned
    // detached (they become their own group leader).
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Resolve a step's working directory, refusing to leave the project root.
 * Configuration is executable, so a relative `cwd` must not be able to walk
 * out of the repository the guard is responsible for.
 */
export function resolveStepCwd(
  baseCwd: string,
  stepCwd?: string,
): { cwd: string; error?: undefined } | { cwd?: undefined; error: string } {
  if (!stepCwd) return { cwd: baseCwd };
  const base = resolve(baseCwd);
  const target = resolve(base, stepCwd);
  const rel = relative(base, target);
  if (rel === "") return { cwd: target };
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { error: `cwd "${stepCwd}" escapes the project root` };
  }
  return { cwd: target };
}

interface Attempt {
  outcome: CommandOutcome;
  attempts: number;
}

export class PipelineRunner {
  /**
   * Run all pipelines for a trigger type (onFileMutation | onTurnEnd).
   * Returns the full run summary, including successes, skips and non-blocking
   * `warnOnly` failures.
   */
  async runAll(
    trigger: "onFileMutation" | "onTurnEnd",
    cwd: string,
    options: RunOptions = {},
  ): Promise<PipelineRunResult> {
    const config = getConfig();
    const configured = config.pipelines[trigger] ?? [];
    const changedFiles = options.changedFiles ?? options.focusPaths ?? [];

    // Phase + file filtering: a step that does not apply is skipped, never
    // silently counted as a pass of a check that never ran.
    const steps: PipelineStep[] = [];
    const skipped: PipelineStepResult[] = [];
    for (const step of configured) {
      if (!stepPhaseMatches(step, trigger)) {
        skipped.push({ ...emptyStep(step.name), skipped: `phase ${step.phase}` });
        continue;
      }
      if (!stepMatchesFiles(step, changedFiles, cwd)) {
        skipped.push({ ...emptyStep(step.name), skipped: "no matching files" });
        continue;
      }
      steps.push(step);
    }

    const results: PipelineStepResult[] = [...skipped];
    const warnings: PipelineWarning[] = [];
    const verificationLog: Parameters<typeof recordVerifications>[0] = [];
    const metrics: Parameters<typeof recordMetrics>[0] = { skippedSteps: skipped.length };

    if (steps.length === 0) {
      recordMetrics(metrics);
      return { passed: true, failure: null, warnings, steps: results };
    }

    // ── Cache lookup ──────────────────────────────────────────────────────
    const cacheSettings = config.verification?.cache;
    const cacheSteps = cacheSettings?.steps;
    const cacheable =
      cacheSettings?.enabled === true &&
      !options.skipCache &&
      steps.every(
        (step) => step.cacheable !== false && (!cacheSteps || cacheSteps.includes(step.name)),
      );
    const cache = getVerificationCache(cwd, {
      enabled: cacheable,
      ttlMs: cacheSettings?.ttlMs ?? 0,
      maxEntries: cacheSettings?.maxEntries ?? 50,
      persist: cacheSettings?.persist ?? false,
    });
    // The key covers the *focus* set, not just the changed files: graph
    // dependents are part of what this check answered about, so their content
    // must be able to invalidate a reused result.
    const cacheKey = cacheable
      ? createCacheKey({ trigger, cwd, focusPaths: options.focusPaths ?? changedFiles, steps })
      : "";
    if (cacheable) {
      const hit = cache.get(cacheKey);
      if (hit) {
        metrics.cacheHits = 1;
        recordMetrics(metrics);
        return {
          ...hit,
          cached: true,
          steps: [...results, ...hit.steps.map((step) => ({ ...step, cached: true }))],
        };
      }
      metrics.cacheMisses = 1;
    }

    try {
      for (const step of steps) {
        const { outcome, attempts } = await this.executeWithRetry(step, cwd, options.signal);
        const timedOut = outcome.timedOut === true;
        const passed = outcome.exitCode === 0;
        const failureKind = passed
          ? undefined
          : outcome.invalidConfig
            ? "environment-error"
            : classifyFailure({
                stepName: step.name,
                cmd: step.cmd,
                exitCode: outcome.exitCode ?? -1,
                timedOut,
                output: outcome.stdout,
              });
        const priority: StepPriority = priorityOf(step);

        results.push({
          name: step.name,
          passed,
          durationMs: outcome.durationMs,
          exitCode: outcome.exitCode ?? -1,
          attempts,
          failureKind,
        });

        verificationLog.push({
          at: new Date().toISOString(),
          step: step.name,
          passed,
          exitCode: outcome.exitCode ?? -1,
          durationMs: outcome.durationMs,
        });

        metrics.checks = (metrics.checks ?? 0) + 1;
        metrics.totalDurationMs = (metrics.totalDurationMs ?? 0) + outcome.durationMs;
        metrics.retries = (metrics.retries ?? 0) + Math.max(0, attempts - 1);
        if (passed) metrics.successes = (metrics.successes ?? 0) + 1;
        else metrics.failures = (metrics.failures ?? 0) + 1;
        if (timedOut) metrics.timeouts = (metrics.timeouts ?? 0) + 1;

        if (passed) continue;

        const prunedTrace = pruneTrace(
          outcome.stdout,
          // A step can override the budget: a noisy linter and a terse compiler
          // want different trace sizes. Unset keeps the global default.
          step.maxTraceLines ?? config.maxTraceLines,
          options.focusPaths,
        );
        const kind: FailureKind = failureKind ?? "unknown";

        if (priority === "warning") {
          // Non-blocking: collect it so the caller can surface it instead of
          // silently swallowing the result. Never triggers a rollback.
          warnings.push({
            step: step.name,
            exitCode: outcome.exitCode ?? -1,
            durationMs: outcome.durationMs,
            prunedTrace,
            failureKind: kind,
            timedOut,
          });
          continue;
        }

        const failure: VerificationResult = {
          passed,
          step: step.name,
          rawOutput: outcome.stdout,
          prunedTrace,
          // Default formatting assumes no rollback; the caller re-formats via
          // formatError() once it knows whether a rollback actually happened.
          formattedError: formatError({
            step: step.name,
            exitCode: outcome.exitCode ?? -1,
            durationMs: outcome.durationMs,
            prunedTrace,
            rawOutput: outcome.stdout,
            warnOnly: false,
            rolledBack: false,
            failureKind: kind,
            timedOut,
            errorSummary: summarizeFailure(kind, outcome.stdout),
            attempts,
          }),
          exitCode: outcome.exitCode ?? -1,
          durationMs: outcome.durationMs,
          warnOnly: false,
          failureKind: kind,
          timedOut,
          signal: outcome.signal,
          errorSummary: summarizeFailure(kind, outcome.stdout),
          affectedFiles: options.focusPaths,
          attempts,
          signature: failureSignature(kind, outcome.stdout),
          priority,
        };
        return { passed: false, failure, warnings, steps: results };
      }

      const runResult: PipelineRunResult = {
        passed: true,
        failure: null,
        warnings,
        steps: results,
      };
      if (cacheable && cache.enabled) cache.set(cacheKey, runResult);
      return runResult;
    } finally {
      // One atomic persist per run instead of one synchronous disk write
      // per step.
      recordMetrics(metrics);
      recordVerifications(verificationLog);
    }
  }

  /**
   * Execute a single pipeline step, retrying only infrastructure failures.
   *
   * A real compile or test failure is never retried: it would cost the user
   * time to learn the same thing twice. A timeout or an unreachable registry
   * is worth a second attempt.
   */
  async executeWithRetry(
    step: PipelineStep,
    baseCwd: string,
    signal?: AbortSignal,
  ): Promise<Attempt> {
    const policy = step.retry;
    const maxAttempts = Math.max(1, policy?.maxAttempts ?? 1);
    const delayMs = Math.max(0, policy?.delayMs ?? 0);

    let attempts = 0;
    let last: CommandOutcome = { stdout: "", exitCode: null, durationMs: 0 };
    let totalMs = 0;

    while (attempts < maxAttempts) {
      attempts += 1;
      last = await this.execute(step, baseCwd, signal);
      totalMs += last.durationMs;
      if (last.exitCode === 0) break;
      if (signal?.aborted || last.aborted) break;
      if (attempts >= maxAttempts) break;

      const kind = classifyFailure({
        stepName: step.name,
        cmd: step.cmd,
        exitCode: last.exitCode ?? -1,
        timedOut: last.timedOut === true,
        output: last.stdout,
      });
      if (!policy || !policy.retryOn.includes(kind)) break;
      if (delayMs > 0) await new Promise((done) => setTimeout(done, delayMs));
    }

    return { outcome: { ...last, durationMs: totalMs }, attempts };
  }

  /**
   * Execute a single pipeline step as a shell subprocess with timeout +
   * bounded, redacted output. Never rejects: failures are reported through
   * the exit code / message.
   */
  async execute(
    step: PipelineStep,
    baseCwd: string,
    signal?: AbortSignal,
  ): Promise<CommandOutcome> {
    const config = getConfig();
    const maxBytes = effectiveMaxOutputBytes(config.verification?.maxOutputBytes);
    const graceMs = config.verification?.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const startedAt = Date.now();

    // A deadline of 0, a negative/NaN value or one beyond the 32-bit timer
    // range does not mean "no deadline": `setTimeout` silently collapses all
    // of them to ~1 ms, which reports every healthy check as a timeout — and
    // with autoRollback on that would undo a perfectly good change. Refuse the
    // step instead of running it with an impossible deadline.
    if (!Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0) {
      return {
        stdout: `[sentinel] ${step.name}: invalid timeoutMs (${String(step.timeoutMs)}); the step was not run. Set a positive timeout in sentinel.config.ts.`,
        exitCode: 1,
        invalidConfig: `invalid timeoutMs: ${String(step.timeoutMs)}`,
        durationMs: Date.now() - startedAt,
      };
    }
    const timeoutMs = Math.min(Math.floor(step.timeoutMs), MAX_TIMER_MS);

    const resolvedCwd = resolveStepCwd(baseCwd, step.cwd);
    if (!resolvedCwd.cwd) {
      return {
        stdout: `[sentinel] ${step.name}: ${resolvedCwd.error}`,
        exitCode: 1,
        invalidConfig: resolvedCwd.error,
        durationMs: Date.now() - startedAt,
      };
    }
    if (signal?.aborted) {
      return {
        stdout: `${step.name}: aborted before start`,
        exitCode: 130,
        aborted: true,
        durationMs: Date.now() - startedAt,
      };
    }

    return new Promise((resolve) => {
      // The effective environment is also what redaction is based on: the
      // credentials a step can leak are exactly the ones it was given.
      const childEnv = { ...process.env, ...step.env };
      const child = spawn(step.cmd, {
        cwd: resolvedCwd.cwd,
        env: childEnv,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        // POSIX: own process group, so the whole tree can be signalled.
        detached: process.platform !== "win32",
      });

      let output = "";
      let truncated = false;
      let done = false;

      const push = (chunk: Buffer | string) => {
        output += chunk.toString();
        if (output.length > maxBytes) {
          // Keep the head (first error) and the tail (summary) instead of
          // letting a runaway process fill the model's context.
          const half = Math.floor(maxBytes / 2);
          output = `${output.slice(0, half)}\n… [sentinel: output truncated at ${maxBytes} characters] …\n${output.slice(-half)}`;
          truncated = true;
        }
      };

      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let escalateTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (outcome: Omit<CommandOutcome, "durationMs">) => {
        if (done) return;
        done = true;
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener("abort", onAbort);
        // Merge what the process printed with the reason this resolve happened
        // (a timeout or abort message has no process output of its own).
        const combined = [output.trim(), outcome.stdout].filter(Boolean).join("\n");
        const clean = redactSecrets(combined + (truncated ? "\n… [truncated]" : ""), childEnv);
        resolve({ ...outcome, stdout: clean, durationMs: Date.now() - startedAt });
      };

      /** SIGTERM, then SIGKILL after the grace period. */
      const terminate = (reason: string) => {
        killProcessTree(child, "SIGTERM");
        // Not unref'd on purpose: this timer is what guarantees the tree is
        // really gone. Dropping it when the loop drains would leave a child
        // alive that sentinel has already reported as killed.
        escalateTimer = setTimeout(() => {
          killProcessTree(child, "SIGKILL");
        }, graceMs);
        return reason;
      };

      const onAbort = () => {
        terminate("aborted");
        finish({
          stdout: `${step.name}: aborted`,
          exitCode: 130,
          aborted: true,
          signal: "SIGTERM",
        });
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      killTimer = setTimeout(() => {
        terminate("timeout");
        finish({
          stdout: `${step.name}: timeout after ${timeoutMs}ms`,
          exitCode: 124,
          timedOut: true,
        });
      }, timeoutMs);

      child.stdout?.on("data", push);
      child.stderr?.on("data", push);

      child.on("close", (code, killSignal) => {
        if (escalateTimer) clearTimeout(escalateTimer);
        finish({
          stdout: "",
          exitCode: code,
          signal: killSignal ?? undefined,
        });
      });

      child.on("error", (err) => {
        if (escalateTimer) clearTimeout(escalateTimer);
        finish({
          stdout: `${step.name}: spawn error: ${err.message}`,
          exitCode: 1,
        });
      });
    });
  }
}

/** A step record that never ran, used for the `skipped` entries. */
function emptyStep(name: string): PipelineStepResult {
  return { name, passed: true, durationMs: 0, exitCode: 0 };
}
