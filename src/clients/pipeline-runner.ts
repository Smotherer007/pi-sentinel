/**
 * PipelineRunner — executes verification pipelines as subprocesses.
 *
 * This is the I/O isolation layer (parallel to pi-email's clients/).
 * Runs configured commands (`tsc`, `eslint`, `cargo check`, tests) with
 * timeouts and in-memory output buffering. Returns structured results.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";

import { pruneTrace, formatError } from "../formatting/pruner.ts";
import { getConfig, recordVerification } from "../config.ts";
import type { PipelineRunResult, PipelineStep, VerificationResult } from "../types.ts";

export interface CommandOutcome {
  stdout: string;
  exitCode: number | null;
}

export class PipelineRunner {
  /**
   * Run all pipelines for a trigger type (onFileMutation | onTurnEnd).
   * Returns the full run summary, including successes.
   */
  async runAll(trigger: "onFileMutation" | "onTurnEnd", cwd: string): Promise<PipelineRunResult> {
    const config = getConfig();
    const steps = config.pipelines[trigger];
    const results: PipelineRunResult["steps"] = [];

    if (!steps || steps.length === 0) {
      return { passed: true, failure: null, steps: [] };
    }

    for (const step of steps) {
      const startedAt = Date.now();
      const outcome = await this.execute(step, cwd);
      const durationMs = Date.now() - startedAt;
      const passed = outcome.exitCode === 0;

      results.push({
        name: step.name,
        passed,
        durationMs,
        exitCode: outcome.exitCode ?? -1,
      });

      recordVerification({
        at: new Date().toISOString(),
        step: step.name,
        passed,
        exitCode: outcome.exitCode ?? -1,
        durationMs,
      });

      if (!passed && !step.warnOnly) {
        const prunedTrace = pruneTrace(outcome.stdout, config.maxTraceLines);
        const failure: VerificationResult = {
          passed,
          step: step.name,
          rawOutput: outcome.stdout,
          prunedTrace,
          formattedError: formatError({
            step: step.name,
            exitCode: outcome.exitCode ?? -1,
            durationMs,
            prunedTrace,
            rawOutput: outcome.stdout,
            warnOnly: step.warnOnly ?? false,
          }),
          exitCode: outcome.exitCode ?? -1,
          durationMs,
          warnOnly: step.warnOnly ?? false,
        };
        return { passed: false, failure, steps: results };
      }
    }

    return { passed: true, failure: null, steps: results };
  }

  /**
   * Execute a single pipeline step as a shell subprocess with timeout +
   * in-memory output buffer.
   */
  async execute(step: PipelineStep, baseCwd: string): Promise<CommandOutcome> {
    return new Promise((resolve) => {
      const cwd = step.cwd ? join(baseCwd, step.cwd) : baseCwd;
      const child = spawn("sh", ["-c", step.cmd], {
        cwd,
        env: { ...process.env, ...step.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let done = false;

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        child.kill("SIGKILL");
        resolve({
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
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ stdout: `${stdout}\n${stderr}`.trim(), exitCode: code });
      });

      child.on("error", (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ stdout: `${stdout}\n${step.name}: spawn error: ${err.message}`, exitCode: 1 });
      });
    });
  }
}
