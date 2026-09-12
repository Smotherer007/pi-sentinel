/**
 * pi-sentinel — In-loop Verification & Rollback Hardening for Pi.
 *
 * Astra/Codex-style guard that runs after file mutations and at turn end.
 * If a verification pipeline fails (type-check, lint, tests), it prunes the
 * error trace to save tokens and feeds a corrected signal back so the agent
 * can self-correct — optionally restoring the working tree to its
 * pre-mutation state.
 *
 * Design (following the pi-email data-oriented pattern):
 *   - All domain data in plain immutable interfaces (src/types.ts)
 *   - I/O isolated in clients/ (pipeline-runner, git-client, snapshot)
 *   - Pure formatting functions in formatting/ (pruner)
 *   - Each capability is a single-responsibility tool module (tools/)
 *   - Config/state in config.ts with atomic, permission-safe persistence
 *
 * Tools:
 *   - sentinel_verify:   Run verification pipelines on demand
 *   - sentinel_rollback: Restore this turn's changes, or reset to HEAD
 *   - sentinel_status:   Show config, git state, history
 *
 * Hooks:
 *   - session_start: Make config cwd-aware, announce armed state.
 *   - turn_start:    Begin a new snapshot scope for the turn.
 *   - tool_call:     Snapshot the target file before an edit/write.
 *   - tool_result:   Run onFileMutation pipelines, roll back on failure and
 *                    surface the outcome by modifying the result.
 *   - turn_end:      Run onTurnEnd pipelines after an agent turn.
 *
 * Commands:
 *   - /sentinel:  Interactive control (status / verify / test / rollback / config)
 */

import type {
  ExtensionAPI,
  ExtensionUIContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { isAbsolute, resolve, relative } from "node:path";

import { PipelineRunner } from "./src/clients/pipeline-runner.ts";
import { GitClient } from "./src/clients/git-client.ts";
import { rollbackMutation, rollbackTurn, rollbackToHead } from "./src/clients/rollback.ts";
import { snapshots } from "./src/clients/snapshot.ts";
import { formatError } from "./src/formatting/pruner.ts";
import {
  loadConfig,
  getConfig,
  shouldVerify,
  getState,
  recordRollback,
} from "./src/config.ts";

import { SentinelVerifyTool } from "./src/tools/sentinel-verify.ts";
import { SentinelRollbackTool } from "./src/tools/sentinel-rollback.ts";
import { SentinelStatusTool } from "./src/tools/sentinel-status.ts";

// Re-exported so `import { defineConfig } from "@patimweb/pi-sentinel"` works
// for the documented config manifest.
export { defineConfig } from "./src/config.ts";
export { DEFAULT_CONFIG } from "./src/config.ts";
export type { SentinelConfig, PipelineStep } from "./src/types.ts";

/**
 * Whether a mutated file path lies inside the project the sentinel guards.
 * The sentinel should only verify/rollback mutations that actually touch its
 * own repo — otherwise it reacts to edits in unrelated projects.
 */
function targetInScope(target: string | undefined, cwd: string): boolean {
  if (!target) return true;
  const abs = isAbsolute(target) ? target : resolve(cwd, target);
  const rel = relative(cwd, abs);
  return rel === "" || !rel.startsWith("..");
}

function absPath(target: string, cwd: string): string {
  return isAbsolute(target) ? target : resolve(cwd, target);
}

export default function (pi: ExtensionAPI) {
  // Resolve configuration on every session event (cwd-aware). We reload
  // each time so editing `sentinel.config.ts` takes effect without a pi
  // restart — loadConfig cache-busts the module by its file mtime.
  async function ensureConfig(cwd: string): Promise<void> {
    await loadConfig(cwd);
  }

  // Abort-safe shared verifier. Optionally restores the working tree on a
  // critical failure (respecting autoRollback and warnOnly) and returns a
  // result we can surface back into the loop.
  async function verifyAndMaybeRollback(
    trigger: "onFileMutation" | "onTurnEnd",
    cwd: string,
    ctx: { ui: ExtensionUIContext },
    opts: { toolCallId?: string; focus?: string } = {},
  ): Promise<{ passed: boolean; formattedError: string }> {
    const conf = getConfig();
    const runner = new PipelineRunner();
    const focusPaths = opts.focus ? [absPath(opts.focus, cwd)] : [];
    const run = await runner.runAll(trigger, cwd, { focusPaths });

    if (run.passed) {
      ctx.ui.setStatus("sentinel", undefined);
      if (run.warnings.length > 0) {
        // warnOnly failures are non-blocking, but the agent should still see
        // them instead of having them silently swallowed.
        const detail = run.warnings.map((w) => `${w.step}: ${w.prunedTrace}`).join("\n");
        ctx.ui.notify(`Sentinel warnings:\n${detail}`, "warning");
      }
      return { passed: true, formattedError: "" };
    }

    const failure = run.failure!;
    ctx.ui.setStatus("sentinel", undefined);

    let rolledBack = false;
    if (conf.autoRollback && !failure.warnOnly) {
      const rb = opts.toolCallId
        ? rollbackMutation(opts.toolCallId, cwd)
        : rollbackTurn(cwd);
      rolledBack = rb.success;
      if (rb.success) {
        recordRollback({
          at: new Date().toISOString(),
          branch: rb.branch ?? "unknown",
          head: rb.committedAt ?? "unknown",
          reason: failure.step,
          method: rb.method,
        });
        ctx.ui.notify(`Sentinel restored your changes (${failure.step} failed)`, "error");
      } else {
        ctx.ui.notify(`Sentinel rollback failed: ${rb.message}`, "error");
      }
    }

    return {
      passed: false,
      formattedError: formatError({
        step: failure.step,
        exitCode: failure.exitCode,
        durationMs: failure.durationMs,
        prunedTrace: failure.prunedTrace,
        rawOutput: failure.rawOutput,
        warnOnly: failure.warnOnly,
        rolledBack,
      }),
    };
  }

  // Register all tools.
  pi.registerTool(SentinelVerifyTool);
  pi.registerTool(SentinelRollbackTool);
  pi.registerTool(SentinelStatusTool);

  // Hook: session_start — make config cwd-aware, announce if enabled.
  pi.on("session_start", async (_event, ctx) => {
    await ensureConfig(ctx.cwd);
    const conf = getConfig();
    if (conf.enabled) {
      ctx.ui.notify("Sentinel armed (verification + rollback)", "info");
    }
  });

  // Hook: turn_start — start a fresh snapshot scope for this turn.
  pi.on("turn_start", async (_event, ctx) => {
    snapshots.beginTurn();
    await ensureConfig(ctx.cwd);
  });

  // Hook: tool_call — snapshot the mutation target and show a status indicator.
  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    await ensureConfig(ctx.cwd);
    const conf = getConfig();
    if (!conf.enabled) return;

    const isMutation =
      isToolCallEventType("edit", event) || isToolCallEventType("write", event);
    if (!isMutation) return;

    const input = event.input as Record<string, unknown>;
    const target = (input.path ?? input.filePath ?? input.file) as string | undefined;
    if (target && !targetInScope(target, ctx.cwd)) return;
    if (target && !shouldVerify(target, conf, ctx.cwd)) return;

    if (target) {
      const abs = absPath(target, ctx.cwd);
      // Captured *before* the mutation runs, so a failure can be undone
      // precisely — including files the agent newly creates.
      snapshots.captureCall(event.toolCallId, abs);
      snapshots.captureTurn(abs);
    }

    ctx.ui.setStatus("sentinel", "Mutation detected — verifying...");
  });

  // Hook: tool_result — run onFileMutation pipelines right after a mutation,
  // restore on failure, and surface the outcome by modifying the result.
  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    await ensureConfig(ctx.cwd);
    const conf = getConfig();
    if (!conf.enabled) return;

    const isMutation = event.toolName === "edit" || event.toolName === "write";
    if (!isMutation) return;

    // A failed edit/write changed nothing — no need to verify.
    if (event.isError) {
      snapshots.endCall(event.toolCallId);
      return;
    }

    const target = (event.input?.path ?? event.input?.filePath) as string | undefined;
    if (target && !targetInScope(target, ctx.cwd)) {
      snapshots.endCall(event.toolCallId);
      return;
    }
    if (target && !shouldVerify(target, conf, ctx.cwd)) {
      snapshots.endCall(event.toolCallId);
      return;
    }

    // Byte-identical rewrite: nothing changed, skip the pipeline entirely.
    if (snapshots.isCallUnchanged(event.toolCallId)) {
      snapshots.endCall(event.toolCallId);
      return;
    }

    const { passed, formattedError } = await verifyAndMaybeRollback(
      "onFileMutation",
      ctx.cwd,
      ctx,
      { toolCallId: event.toolCallId, focus: target },
    );

    snapshots.endCall(event.toolCallId);

    if (passed) return;

    // Prepend the pruned error while keeping the original result blocks.
    return {
      content: [{ type: "text" as const, text: formattedError }, ...(event.content ?? [])],
      isError: true as const,
    };
  });

  // Hook: turn_end — run onTurnEnd pipelines after each agent turn.
  // A failed check is surfaced back to the agent/human so it can
  // self-correct. The working tree is restored only when the project opts
  // in via `autoRollback: true`.
  pi.on("turn_end", async (_event, ctx) => {
    await ensureConfig(ctx.cwd);
    const conf = getConfig();
    if (!conf.enabled) return;

    if (conf.pipelines.onTurnEnd.length > 0) {
      const { passed, formattedError } = await verifyAndMaybeRollback("onTurnEnd", ctx.cwd, ctx);
      if (!passed && formattedError) {
        ctx.ui.notify(formattedError, "error");
      }
    }

    // The turn is over — drop its snapshot scope either way.
    snapshots.beginTurn();
  });

  // Register /sentinel command.
  pi.registerCommand("sentinel", {
    description: "Sentinel verification & rollback control",
    getArgumentCompletions: (prefix) => {
      const options = ["status", "verify", "test", "rollback", "config", "help"];
      return options.filter((o) => o.startsWith(prefix)).map((o) => ({ label: o, value: o }));
    },
    handler: async (args, ctx) => {
      await ensureConfig(ctx.cwd);
      const conf = getConfig();
      const [sub = "help"] = (args ?? "").trim().split(/\s+/);

      let text: string;
      switch (sub) {
        case "status": {
          const repo = GitClient.gitMeta(ctx.cwd);
          const state = getState();
          text = [
            "[sentinel] Status",
            `  enabled: ${conf.enabled}`,
            `  autoRollback: ${conf.autoRollback}`,
            `  maxTraceLines: ${conf.maxTraceLines}`,
            `  pipelines onFileMutation: ${conf.pipelines.onFileMutation.length}`,
            `  pipelines onTurnEnd: ${conf.pipelines.onTurnEnd.length}`,
            repo ? `  Git: ${repo.branch} @ ${repo.head}` : "  Git: not a repo",
            `  turn snapshot: ${snapshots.hasTurnSnapshot() ? "captured" : "empty"}`,
            `  rollbacks logged: ${state.rollbackHistory.length}`,
          ].join("\n");
          break;
        }
        case "verify": {
          const runner = new PipelineRunner();
          const run = await runner.runAll("onFileMutation", ctx.cwd);
          text = run.passed
            ? `[sentinel] All ${run.steps.length} checks passed.`
            : run.failure!.formattedError;
          break;
        }
        case "test": {
          const runner = new PipelineRunner();
          const run = await runner.runAll("onTurnEnd", ctx.cwd);
          text = run.passed
            ? `[sentinel] All ${run.steps.length} turn-end checks passed.`
            : run.failure!.formattedError;
          break;
        }
        case "rollback": {
          const result = snapshots.hasTurnSnapshot()
            ? rollbackTurn(ctx.cwd)
            : rollbackToHead(ctx.cwd);
          text = `[sentinel] ${result.message}`;
          break;
        }
        case "config":
          text = JSON.stringify(conf, null, 2);
          break;
        case "help":
        default:
          text = [
            "[sentinel] Commands",
            "  /sentinel           Show this help",
            "  /sentinel status    Show current state",
            "  /sentinel verify    Run onFileMutation pipelines now",
            "  /sentinel test      Run onTurnEnd pipelines now",
            "  /sentinel rollback  Restore this turn's changes (or HEAD)",
            "  /sentinel config    Dump the active configuration",
          ].join("\n");
      }

      ctx.ui.setWidget("sentinel", text.split("\n"));
    },
  });
}
