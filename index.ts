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
 *   - tool_call:  Detect file mutations, inject pre-flight awareness
 *   - turn_end:   Run onTurnEnd pipelines after an agent turn
 *
 * Commands:
 *   - /sentinel:  Interactive control (status / verify / test / rollback / config)
 */

import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

import { PipelineRunner } from "./src/clients/pipeline-runner.ts";
import { GitClient } from "./src/clients/git-client.ts";
import { loadConfig, loadState, getConfig, isExcluded, recordRollback } from "./src/config.ts";

import { SentinelVerifyTool } from "./src/tools/sentinel-verify.ts";
import { SentinelRollbackTool } from "./src/tools/sentinel-rollback.ts";
import { SentinelStatusTool } from "./src/tools/sentinel-status.ts";

export default function (pi: ExtensionAPI) {
  // Load persisted state on startup
  loadState();

  // Resolve configuration lazily on first session event (cwd-aware).
  let configLoaded = false;
  async function ensureConfig(cwd: string): Promise<void> {
    if (!configLoaded) {
      await loadConfig(cwd);
      configLoaded = true;
    }
  }

  // Register all tools
  pi.registerTool(SentinelVerifyTool);
  pi.registerTool(SentinelRollbackTool);
  pi.registerTool(SentinelStatusTool);

  // Hook: session_start — make config cwd-aware, announce if enabled
  pi.on("session_start", async (_event, ctx) => {
    await ensureConfig(ctx.cwd);
    const conf = getConfig();
    if (conf.enabled) {
      ctx.ui.notify("Sentinel armed (verification + rollback)", "info");
    }
  });

  // Hook: tool_call — intervene on file mutations
  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    await ensureConfig(ctx.cwd);
    const conf = getConfig();
    if (!conf.enabled) return;

    const isMutation =
      isToolCallEventType("edit", event) ||
      isToolCallEventType("write", event);

    if (!isMutation) return;

    // Respect exclude patterns for targeted files.
    const input = event.input as Record<string, unknown>;
    const target = (input.filePath ?? input.path ?? input.file) as string | undefined;
    if (target && isExcluded(target, conf)) return;

    ctx.ui.setStatus("sentinel", "Verifying mutation...");
  });

  // Hook: turn_end — run onTurnEnd pipelines after each agent turn.
  pi.on("turn_end", async (_event, ctx) => {
    await ensureConfig(ctx.cwd);
    const conf = getConfig();
    if (!conf.enabled) return;

    // Skip if git isn't available and rollback would be a no-op.
    if (!GitClient.isGitRepo(ctx.cwd)) return;

    const runner = new PipelineRunner();
    const run = await runner.runAll("onTurnEnd", ctx.cwd);

    if (!run.passed && run.failure) {
      const failure = run.failure;
      ctx.ui.setStatus("sentinel", "");

      if (conf.autoRollback && !failure.warnOnly) {
        const rb = GitClient.rollback(ctx.cwd);
        if (rb.success) {
          recordRollback({
            at: new Date().toISOString(),
            branch: rb.branch ?? "unknown",
            head: rb.committedAt ?? "unknown",
            reason: failure.step,
            method: rb.method,
          });
          ctx.ui.notify(`Sentinel rolled back (${failure.step} failed)`, "error");
          // Inject a steer message so the agent sees the error + that rollback happened.
          pi.sendUserMessage(failure.formattedError, { deliverAs: "steer" });
        }
      }
    }
  });

  // Register /sentinel command
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
