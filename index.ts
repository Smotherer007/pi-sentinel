/**
 * pi-sentinel — In-loop Verification & Rollback Hardening for Pi.
 *
 * Astra/Codex-style guard that runs after file mutations and at turn end.
 * If a verification pipeline fails (type-check, lint, tests), it prunes the
 * error trace to save tokens and rolls the working tree back so bad code
 * never pollutes the agent's context.
 *
 * Design (following the pi-email data-oriented pattern):
 *   - All domain data in plain immutable interfaces (src/types.ts)
 *   - I/O isolated in clients/ (pipeline-runner, git-client)
 *   - Pure formatting functions in formatting/ (pruner)
 *   - Each capability is a single-responsibility tool module (tools/)
 *   - Config/state in config.ts with atomic, permission-safe persistence
 *
 * Tools:
 *   - sentinel_verify:   Run verification pipelines on demand
 *   - sentinel_rollback: Manually roll back the working tree
 *   - sentinel_status:   Show config, git state, history
 *
 * Hooks:
 *   - session_start:  Make config cwd-aware, announce armed state.
 *   - tool_call:      Detect file mutations (edit/write), set status indicator.
 *   - tool_result:    Run onFileMutation pipelines after an edit/write and
 *                     auto-rollback + modify the result on failure.
 *   - turn_end:       Run onTurnEnd pipelines after an agent turn.
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
import { loadConfig, loadState, getConfig, isExcluded, recordRollback } from "./src/config.ts";

import { SentinelVerifyTool } from "./src/tools/sentinel-verify.ts";
import { SentinelRollbackTool } from "./src/tools/sentinel-rollback.ts";
import { SentinelStatusTool } from "./src/tools/sentinel-status.ts";

/**
 * Whether a mutated file path lies inside the project the sentinel guards.
 * The sentinel should only verify/rollback mutations that actually touch its
 * own repo — otherwise it reacts to edits in unrelated projects (and can bar
 * rolling back the wrong tree) on every such edit.
 */
function targetInScope(target: string | undefined, cwd: string): boolean {
  // No target → fall through to existing logic (skip is handled elsewhere).
  if (!target) return true;
  const abs = isAbsolute(target) ? target : resolve(cwd, target);
  const rel = relative(cwd, abs);
  return rel === "" || !rel.startsWith("..");
}

export default function (pi: ExtensionAPI) {
  // Load persisted state on startup.
  loadState();

  // Resolve configuration on every session event (cwd-aware). We reload
  // each time so editing `sentinel.config.ts` takes effect without a pi
  // restart — loadConfig cache-busts the module by its file mtime.
  async function ensureConfig(cwd: string): Promise<void> {
    await loadConfig(cwd);
  }

  // Abort-safe shared verifier. Rolls back the working tree on an invariant
  // violation (respecting autoRollback and warnOnly) and returns a result we
  // can surface back into the loop.
  async function verifyAndMaybeRollback(
    trigger: "onFileMutation" | "onTurnEnd",
    cwd: string,
    ctx: { ui: ExtensionUIContext },
  ): Promise<{ passed: boolean; formattedError: string }> {
    const conf = getConfig();
    const runner = new PipelineRunner();
    const run = await runner.runAll(trigger, cwd);

    if (run.passed) {
      ctx.ui.setStatus("sentinel", undefined);
      return { passed: true, formattedError: "" };
    }

    const failure = run.failure!;
    ctx.ui.setStatus("sentinel", undefined);

    if (conf.autoRollback && !failure.warnOnly) {
      const rb = GitClient.rollback(cwd);
      if (rb.success) {
        recordRollback({
          at: new Date().toISOString(),
          branch: rb.branch ?? "unknown",
          head: rb.committedAt ?? "unknown",
          reason: failure.step,
          method: rb.method,
        });
        ctx.ui.notify(`Sentinel rolled back (${failure.step} failed)`, "error");
      }
    }

    return { passed: false, formattedError: failure.formattedError };
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

  // Hook: tool_call — detect file mutations and show a status indicator.
  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    await ensureConfig(ctx.cwd);
    const conf = getConfig();
    if (!conf.enabled) return;

    const isMutation =
      isToolCallEventType("edit", event) || isToolCallEventType("write", event);
    if (!isMutation) return;

    // Respect exclude patterns for targeted files.
    const input = event.input as Record<string, unknown>;
    const target = (input.filePath ?? input.path ?? input.file) as string | undefined;
    if (target && isExcluded(target, conf)) return;
    if (target && !targetInScope(target, ctx.cwd)) return;

    ctx.ui.setStatus("sentinel", "Mutation detected — verifying...");
  });

  // Hook: tool_result — run onFileMutation pipelines right after a mutation,
  // roll back on failure, and surface the outcome by modifying the result.
  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    await ensureConfig(ctx.cwd);
    const conf = getConfig();
    if (!conf.enabled) return;

    const isMutation = event.toolName === "edit" || event.toolName === "write";
    if (!isMutation) return;

    // Respect exclude patterns for targeted files.
    const target = (event.input?.filePath ?? event.input?.path) as string | undefined;
    if (target && isExcluded(target, conf)) return;
    if (target && !targetInScope(target, ctx.cwd)) return;

    const { passed, formattedError } = await verifyAndMaybeRollback("onFileMutation", ctx.cwd, ctx);

    if (passed) return;

    // Surface the pruned error by modifying the tool result in place.
    return {
      content: [{ type: "text" as const, text: `${formattedError}\n\n(previous result: ${event.content?.[0]?.type === "text" ? event.content[0].text : ""})` }],
      isError: true as const,
    };
  });

  // Hook: turn_end — run onTurnEnd pipelines after each agent turn.
  // Following Claude Code / Codex: a failed check is surfaced back to the
  // agent/human so it can self-correct. Recovery is manual; the working tree
  // is only reset when the project opts in via `autoRollback: true`.
  pi.on("turn_end", async (_event, ctx) => {
    await ensureConfig(ctx.cwd);
    const conf = getConfig();
    if (!conf.enabled) return;

    if (conf.pipelines.onTurnEnd.length === 0) return;

    const { passed, formattedError } = await verifyAndMaybeRollback("onTurnEnd", ctx.cwd, ctx);
    if (!passed && formattedError) {
      ctx.ui.notify(formattedError, "error");
    }
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
          text = [
            "[sentinel] Status",
            `  enabled: ${conf.enabled}`,
            `  autoRollback: ${conf.autoRollback}`,
            `  maxTraceLines: ${conf.maxTraceLines}`,
            `  pipelines onFileMutation: ${conf.pipelines.onFileMutation.length}`,
            `  pipelines onTurnEnd: ${conf.pipelines.onTurnEnd.length}`,
            repo ? `  Git: ${repo.branch} @ ${repo.head}` : "  Git: not a repo (rollback unavailable)",
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
          const result = GitClient.rollback(ctx.cwd);
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
            "  /sentinel rollback  Roll back working tree",
            "  /sentinel config    Dump the active configuration",
          ].join("\n");
      }

      ctx.ui.setWidget("sentinel", text.split("\n"));
    },
  });
}
