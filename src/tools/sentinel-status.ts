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

    const verifications = state.lastVerifications.slice(0, 5).map((v) => {
      return `  ${v.at} | ${v.step} | ${v.passed ? "PASS" : "FAIL"} | exit ${v.exitCode} | ${v.durationMs}ms`;
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

    const text = [
      "[sentinel] Status",
      `  enabled: ${conf.enabled}`,
      `  autoRollback: ${conf.autoRollback} | autoFix: ${conf.autoFix} (max ${conf.maxAutoRetries} attempts)`,
      `  trackVerifiedState: ${conf.trackVerifiedState} | revertOnRegression: ${conf.revertOnRegression}`,
      `  pruneStaleTraces: ${conf.pruneStaleTraces} | detectOutOfBand: ${conf.detectOutOfBand}`,
      `  revisionContract: ${conf.revisionContract} | backgroundTurnEnd: ${conf.backgroundTurnEnd}`,
      `  impactAwareFocus: ${conf.impactAwareFocus} | maxOutputTokens: ${conf.maxOutputTokens}`,
      `  maxTraceLines: ${conf.maxTraceLines} | checkpointRetention: ${conf.checkpointRetention}`,
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
      state.lastVerifications.length > 0
        ? `Recent verifications (${state.lastVerifications.length}):\n${verifications.join("\n")}`
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
        rollbackHistory: state.rollbackHistory,
      },
    };
  },
};
