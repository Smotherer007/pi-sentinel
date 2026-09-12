/**
 * PipelineRunner — executes verification pipelines as subprocesses.
 *
 * This is the I/O isolation layer (parallel to pi-email's clients/).
 * Runs configured commands (`tsc`, `eslint`, `cargo check`, tests) with
 * timeouts and in-memory output buffering. Returns structured results.
 *
 * Portability: commands run through the platform shell (`shell: true`), so
 * the same config works on POSIX (`/bin/sh`) and Windows (`cmd.exe`).
 * Abort: when the caller passes an `AbortSignal`, the child process is
 * killed as soon as the loop is interrupted.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";

import { pruneTrace, formatError } from "../formatting/pruner.ts";
import { getConfig, recordVerifications } from "../config.ts";
import type {
  PipelineRunResult,
  PipelineStep,
  PipelineWarning,
  VerificationResult,
} from "../types.ts";

export interface CommandOutcome {
  stdout: string;
  exitCode: number | null;
  aborted?: boolean;
}

export interface RunOptions {
  /** Abort signal from the tool/hook context; kills the running child. */
  signal?: AbortSignal;
  /** File paths just mutated — diagnostics about them are promoted. */
  focusPaths?: string[];
}

export class PipelineRunner {
  /**
   * Run all pipelines for a trigger type (onFileMutation | onTurnEnd).
   * Returns the full run summary, including successes and non-blocking
   * `warnOnly` failures.
   */
  async runAll(
    trigger: "onFileMutation" | "onTurnEnd",
    cwd: string,
    options: RunOptions = {},
  ): Promise<PipelineRunResult> {
    const config = getConfig();
    const steps = config.pipelines[trigger];
    const results: PipelineRunResult["steps"] = [];
    const warnings: PipelineWarning[] = [];
    const verificationLog: Parameters<typeof recordVerifications>[0] = [];

    if (!steps || steps.length === 0) {
      return { passed: true, failure: null, warnings, steps: [] };
    }

    try {
      for (const step of steps) {
        const startedAt = Date.now();
        const outcome = await this.execute(step, cwd, options.signal);
        const durationMs = Date.now() - startedAt;
        const passed = outcome.exitCode === 0;

        results.push({
          name: step.name,
          passed,
          durationMs,
          exitCode: outcome.exitCode ?? -1,
        });

        verificationLog.push({
          at: new Date().toISOString(),
          step: step.name,
          passed,
          exitCode: outcome.exitCode ?? -1,
          durationMs,
        });

        if (passed) continue;

        const prunedTrace = pruneTrace(outcome.stdout, config.maxTraceLines, options.focusPaths);

        if (step.warnOnly) {
          // Non-blocking: collect it so the caller can surface it instead of
          // silently swallowing the result.
          warnings.push({
            step: step.name,
            exitCode: outcome.exitCode ?? -1,
            durationMs,
            prunedTrace,
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
            durationMs,
            prunedTrace,
            rawOutput: outcome.stdout,
            warnOnly: false,
            rolledBack: false,
          }),
          exitCode: outcome.exitCode ?? -1,
          durationMs,
          warnOnly: false,
        };
        return { passed: false, failure, warnings, steps: results };
      }

      return { passed: true, failure: null, warnings, steps: results };
    } finally {
      // One atomic persist per run instead of one synchronous disk write
      // per step.
      recordVerifications(verificationLog);
    }
  }

  /**
   * Execute a single pipeline step as a shell subprocess with timeout +
   * in-memory output buffer. Never rejects: failures are reported through
   * the exit code / message.
   */
  async execute(
    step: PipelineStep,
    baseCwd: string,
    signal?: AbortSignal,
  ): Promise<CommandOutcome> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve({ stdout: `${step.name}: aborted before start`, exitCode: 130, aborted: true });
        return;
      }

      const cwd = step.cwd ? join(baseCwd, step.cwd) : baseCwd;
      const child = spawn(step.cmd, {
        cwd,
        env: { ...process.env, ...step.env },
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let done = false;

      const finish = (outcome: CommandOutcome) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };

      const onAbort = () => {
        child.kill("SIGKILL");
        finish({ stdout: `${stdout}\n${stderr}\n${step.name}: aborted`, exitCode: 130, aborted: true });
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({
          stdout: `${stdout}\n${stderr}\n${step.name}: timeout after ${step.timeoutMs}ms`,
          exitCode: 124,
        });
      }, step.timeoutMs);

      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
        if (stdout.length > 1_000_000) stdout = stdout.slice(-1_000_000);
      });

      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
        if (stderr.length > 1_000_000) stderr = stderr.slice(-1_000_000);
      });

      child.on("close", (code) => {
        finish({ stdout: `${stdout}\n${stderr}`.trim(), exitCode: code });
      });

      child.on("error", (err) => {
        finish({
          stdout: `${stdout}\n${step.name}: spawn error: ${err.message}`,
          exitCode: 1,
        });
      });
    });
  }
}
