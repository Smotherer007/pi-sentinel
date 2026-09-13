/**
 * sentinel_status tool -- Show current configuration and runtime state.
 *
 * Reports whether sentinel is enabled, the active pipelines, git repo status,
 * durable checkpoints, verified-state evidence, code-graph availability and
 * the recent rollback / auto-fix / verification history.
 */

import { Type } from "typebox";

import { GitClient } from "../clients/git-client.ts";
import { snapshots } from "../clients/snapshot.ts";
import { checkpoints } from "../clients/checkpoints.ts";
import { allVerified } from "../clients/evidence.ts";
import { graphStatus } from "../clients/mindplace.ts";
import { peekVerificationCache } from "../clients/cache.ts";
import { escalations } from "../clients/escalation.ts";
import { metricsLines, turnHistoryLines, verificationLines } from "../formatting/status.ts";
import { getConfig, getState } from "../config.ts";

export const SentinelStatusTool = {
  name: "sentinel_status",
  label: "Sentinel Status",
  description:
    "Show the current sentinel configuration, git state, checkpoints, verified-state evidence and recent rollback/verification history.",
  parameters: Type.Object({}),

  async execute(
    _toolCallId: string,
    _params: Record<string, never>,
    _signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx?: { cwd: string },
  ) {
    const conf = getConfig();
    const cwd = ctx?.cwd ?? process.cwd();
    const repo = GitClient.gitMeta(cwd);
    const state = getState();

    const gitOk = repo
      ? `Git: ${repo.branch} @ ${repo.head}`
      : "Git: not a repo (head reset unavailable)";

    const history = state.rollbackHistory.slice(0, 5).map((h) => {
      return `  ${h.at} | ${h.branch} @ ${h.head} | ${h.method} | ${h.reason}`;
    });

    const autoFixes = state.autoFixHistory.slice(0, 5).map((a) => {
      return `  ${a.at} | ${a.step} | attempt ${a.attempt} | ${a.outcome} (${a.reason})`;
    });

    const regressions = state.regressions.slice(0, 5).map((r) => {
      return `  ${r.at} | ${r.path} | verified ${r.verifiedAt} | ${r.reverted ? "reverted" : "kept"}`;
    });

    const checkpointList = checkpoints.list(cwd, 5).map((cp) => {
      return `  ${cp.id} | ${cp.at} | turn ${cp.turnIndex} | ${cp.fileCount} file(s) | ${cp.label}`;
    });

    const evidence = allVerified(cwd);
    const graph = graphStatus(cwd);
    const cacheStats = peekVerificationCache()?.stats();
    const trackedEscalations = escalations.snapshot();

    const text = [
      "[sentinel] Status",
      `  enabled: ${conf.enabled}`,
      `  autoRollback: ${conf.autoRollback}`,
      `  recovery: ${conf.recovery.enabled} | maxAttempts: ${conf.recovery.maxAttempts} | rollbackAfterExhaustion: ${conf.recovery.rollbackAfterExhaustion}`,
      `  policy: ${conf.policy.enabled} | maxChangedFiles: ${conf.policy.maxChangedFiles || "unlimited"} | maxAddedLines: ${conf.policy.maxAddedLines || "unlimited"} | allowWorkflow: ${conf.policy.allowWorkflowChanges}`,
      `  autoFix (legacy alias): ${conf.autoFix} (max ${conf.maxAutoRetries} attempts)`,
      `  trackVerifiedState: ${conf.trackVerifiedState} | revertOnRegression: ${conf.revertOnRegression}`,
      `  pruneStaleTraces: ${conf.pruneStaleTraces} | detectOutOfBand: ${conf.detectOutOfBand}`,
      `  revisionContract: ${conf.revisionContract} | backgroundTurnEnd: ${conf.backgroundTurnEnd}`,
      `  impactAwareFocus: ${conf.impactAwareFocus} | maxOutputTokens: ${conf.maxOutputTokens}`,
      `  maxTraceLines: ${conf.maxTraceLines} | checkpointRetention: ${conf.checkpointRetention}`,
      `  debounce: ${conf.verification.debounceMs}ms | maxOutputBytes: ${conf.verification.maxOutputBytes} | killGrace: ${conf.verification.killGraceMs}ms`,
      `  cache: ${conf.verification.cache.enabled} (ttl ${conf.verification.cache.ttlMs}ms) | escalation: ${conf.verification.failureEscalation.enabled} at ${conf.verification.failureEscalation.maxRepeatedFailures}`,
      `  pipelines onFileMutation: ${conf.pipelines.onFileMutation.length}`,
      `  pipelines onTurnEnd: ${conf.pipelines.onTurnEnd.length}`,
      `  exclude: ${conf.exclude.join(", ") || "(none)"}`,
      `  include: ${conf.include.join(", ") || "(all non-excluded files)"}`,
      `  ${gitOk}`,
      `  turn snapshot: ${snapshots.hasTurnSnapshot() ? "captured (rollback available)" : "empty"}`,
      `  code graph (mindplace): ${
        graph.present
          ? `${graph.nodeCount} nodes / ${graph.edgeCount} edges${graph.stale ? " (stale)" : ""}`
          : "absent (impact analysis disabled)"
      }`,
      `  verified states: ${evidence.length}`,
      "",
      ...metricsLines(state.metrics),
      "",
      cacheStats
        ? `Cache (this session): ${cacheStats.hits} hit(s) / ${cacheStats.misses} miss(es) / ${cacheStats.entries} entr(ies)`
        : "Cache: not used in this session",
      "",
      state.turnHistory.length > 0
        ? ["Recent turns (newest first):", ...turnHistoryLines(state.turnHistory)].join("\n")
        : "Recent turns: none",
      "",
      checkpointList.length > 0
        ? `Recent checkpoints (${checkpointList.length}):\n${checkpointList.join("\n")}`
        : "Recent checkpoints: none",
      "",
      state.rollbackHistory.length > 0
        ? `Recent rollbacks (${state.rollbackHistory.length}):\n${history.join("\n")}`
        : "Recent rollbacks: none",
      "",
      state.autoFixHistory.length > 0
        ? `Recent auto-fix decisions (${state.autoFixHistory.length}):\n${autoFixes.join("\n")}`
        : "Recent auto-fix decisions: none",
      "",
      state.regressions.length > 0
        ? `Recent regressions (${state.regressions.length}):\n${regressions.join("\n")}`
        : "Recent regressions: none",
      "",
      state.policyViolations.length > 0
        ? `Recent policy violations (${state.policyViolations.length}):\n${state.policyViolations
            .slice(0, 5)
            .map((p) => `  ${p.at} | ${p.rules.join(", ")} | ${p.files.slice(0, 3).join(", ") || "(no paths)"}`)
            .join("\n")}`
        : "Recent policy violations: none",
      "",
      trackedEscalations.length > 0
        ? `Escalating failures (this session):\n${trackedEscalations
            .slice(0, 5)
            .map((e) => `  ${e.signature} — seen ${e.count}x`)
            .join("\n")}`
        : "Escalating failures: none",
      "",
      state.lastVerifications.length > 0
        ? `Recent verifications (${state.lastVerifications.length}):\n${verificationLines(
            state.lastVerifications,
            5,
          ).join("\n")}`
        : "Recent verifications: none",
    ].join("\n");

    return {
      content: [{ type: "text" as const, text }],
      details: {
        enabled: conf.enabled,
        autoRollback: conf.autoRollback,
        autoFix: conf.autoFix,
        git: repo,
        turnSnapshot: snapshots.hasTurnSnapshot(),
        checkpoints: checkpoints.list(cwd, 5),
        verifiedStates: evidence.length,
        graph,
        metrics: state.metrics,
        turnHistory: state.turnHistory.slice(0, 10),
        policyViolations: state.policyViolations.slice(0, 10),
        cache: cacheStats ?? null,
        rollbackHistory: state.rollbackHistory,
      },
    };
  },
};
