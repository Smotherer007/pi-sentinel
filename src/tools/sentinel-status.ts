/**
 * sentinel_status tool -- Show current configuration and runtime state.
 *
 * Reports whether sentinel is enabled, the active pipelines, git repo
 * status, and recent rollback / verification history.
 */

import { Type } from "typebox";

import { GitClient } from "../clients/git-client.ts";
import { snapshots } from "../clients/snapshot.ts";
import { getConfig, getState } from "../config.ts";

export const SentinelStatusTool = {
  name: "sentinel_status",
  label: "Sentinel Status",
  description:
    "Show the current sentinel configuration, git state, and recent rollback/verification history.",
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

    const text = [
      "[sentinel] Status",
      `  enabled: ${conf.enabled}`,
      `  autoRollback: ${conf.autoRollback}`,
      `  maxTraceLines: ${conf.maxTraceLines}`,
      `  pipelines onFileMutation: ${conf.pipelines.onFileMutation.length}`,
      `  pipelines onTurnEnd: ${conf.pipelines.onTurnEnd.length}`,
      `  exclude: ${conf.exclude.join(", ") || "(none)"}`,
      `  include: ${conf.include.join(", ") || "(all non-excluded files)"}`,
      `  ${gitOk}`,
      `  turn snapshot: ${snapshots.hasTurnSnapshot() ? "captured (rollback available)" : "empty"}`,
      "",
      state.rollbackHistory.length > 0
        ? `Recent rollbacks (${state.rollbackHistory.length}):\n${history.join("\n")}`
        : "Recent rollbacks: none",
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
        git: repo,
        turnSnapshot: snapshots.hasTurnSnapshot(),
        rollbackHistory: state.rollbackHistory,
      },
    };
  },
};
