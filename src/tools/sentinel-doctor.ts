/**
 * sentinel_doctor tool — is sentinel working, right now, in this project?
 *
 * `sentinel_status` prints everything sentinel knows; doctor prints what a
 * reader needs to decide. The difference is the classification: a check that
 * fails here is something broken *now*, a warning is something imperfect, and
 * the safety block is what a bad turn would cost.
 *
 * The facts are gathered here (git, disk, graph, cache — the I/O) and the
 * judgement lives in `formatting/doctor.ts`, which is pure and therefore
 * testable without a session. The session facts are passed in by `index.ts`,
 * because a retired ctx, an in-flight background run and an open repair cycle
 * exist only in the extension instance.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";

import type { SentinelRuntime } from "../runtime.ts";
import { GitClient } from "../clients/git-client.ts";
import { allVerified } from "../clients/evidence.ts";
import { graphStatus } from "../clients/mindplace.ts";
import { peekVerificationCache } from "../clients/cache.ts";
import { homeDir, projectDir, scopeKey } from "../config.ts";
import { hasGlobalConfig, hasProjectConfig, onPath } from "../clients/init.ts";
import { buildDoctorReport, formatDoctorReport } from "../formatting/doctor.ts";
import type { DoctorFacts, DoctorStep } from "../formatting/doctor.ts";
import type { PipelineStep } from "../types.ts";

/** What only the extension instance knows about its own session. */
export interface DoctorSessionProbe {
  ctxRetired: boolean;
  backgroundRunning: boolean;
  backgroundPending: boolean;
  failureOutstanding: boolean;
  repairAttempts: number;
  maxAttempts: number;
  turnSnapshotFiles: number;
  startedAtMs: number;
}

/**
 * Shell words that are builtins, not programs.
 *
 * Without this a step like `exit 0` reads as a missing command, and a doctor
 * that cries wolf is worse than no doctor.
 */
const SHELL_BUILTINS: ReadonlySet<string> = new Set([
  "exit",
  "cd",
  "echo",
  "set",
  "unset",
  "export",
  "test",
  "true",
  "false",
  ":",
  ".",
  "source",
  "shift",
  "trap",
  "wait",
  "exec",
  "read",
  "local",
  "return",
  "break",
  "continue",
  "umask",
  "alias",
  "eval",
  "readonly",
  "times",
  "type",
  "ulimit",
]);

/** The program a step's command starts with, when it has one. */
function commandOf(cmd: string): string | undefined {
  const first = cmd.trim().split(/\s+/)[0] ?? "";
  if (first.length === 0) return undefined;
  if (first.includes("/") || first.includes("=")) return undefined;
  if (SHELL_BUILTINS.has(first)) return undefined;
  if (first.startsWith("$") || first.startsWith("(")) return undefined;
  return first;
}

function reduce(step: PipelineStep): DoctorStep {
  return {
    name: step.name,
    timeoutMs: step.timeoutMs,
    files: (step.files ?? []).length,
    cacheable: step.cacheable !== false,
  };
}

/** Sentinel's own directory must exist and be writable for anything to persist. */
function ensureWritable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function createSentinelDoctorTool(
  runtime: SentinelRuntime,
  probe: () => DoctorSessionProbe,
) {
  return {
    name: "sentinel_doctor",
    label: "Sentinel Doctor",
    description:
      "Check whether sentinel is actually working in this project: hooks, session state, storage, git, pipelines, graph, rollback readiness and the open repair cycle. Use it when a sentinel message looks wrong or before trusting sentinel after a reload.",
    parameters: Type.Object({}),

    async execute(
      _toolCallId: string,
      _params: Record<string, never>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx?: { cwd: string },
    ) {
      const cwd = ctx?.cwd ?? process.cwd();
      const conf = runtime.config.config();
      const state = runtime.config.state();
      const session = probe();
      const dir = projectDir(cwd);

      const allSteps = [...conf.pipelines.onFileMutation, ...conf.pipelines.onTurnEnd];
      const missing = [
        ...new Set(
          allSteps
            .map((step) => commandOf(step.cmd))
            .filter((program): program is string => program !== undefined && !onPath(program)),
        ),
      ];

      // The newest red and green *turn*, which is what a trace in the
      // conversation is about. Step-level runs are the fallback for a session
      // whose turns have not produced one yet.
      const reds = state.turnHistory.filter((entry) => !entry.passed);
      const greens = state.turnHistory.filter((entry) => entry.passed);
      const lastRed = reds[0] ?? state.lastVerifications.find((entry) => !entry.passed);
      const lastGreen = greens[0] ?? state.lastVerifications.find((entry) => entry.passed);
      const graph = graphStatus(cwd);
      // The state directory lives under $HOME, where a path relative to the
      // project is a row of `../../..` that tells the reader nothing.
      const home = homeDir();
      const showDir = dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;

      const facts: DoctorFacts = {
        cwd,
        scopeKey: scopeKey(cwd),
        nodeVersion: process.versions.node,
        session: {
          startedAtMs: session.startedAtMs,
          ctxRetired: session.ctxRetired,
          backgroundRunning: session.backgroundRunning,
          backgroundPending: session.backgroundPending,
          failureOutstanding: session.failureOutstanding,
          repairAttempts: session.repairAttempts,
          maxAttempts: session.maxAttempts,
          turnSnapshotFiles: session.turnSnapshotFiles,
        },
        config: {
          enabled: conf.enabled,
          recoveryEnabled: conf.recovery.enabled,
          autoRollback: conf.autoRollback,
          revertOnRegression: conf.revertOnRegression,
          bashEnabled: conf.bash.enabled,
          bashMode: conf.bash.mode,
          protectedPaths: conf.policy.sensitivePaths.length,
          learnMutationTools: conf.learnMutationTools,
          learnedTools: [...state.learnedMutationTools],
          configured: hasProjectConfig(cwd) || hasGlobalConfig(homeDir()),
          onFileMutation: conf.pipelines.onFileMutation.map(reduce),
          onTurnEnd: conf.pipelines.onTurnEnd.map(reduce),
          missingCommands: missing,
        },
        storage: {
          stateDir: showDir,
          writable: ensureWritable(dir),
          checkpointCount: runtime.checkpoints.list(cwd, 500).length,
          verifiedCount: allVerified(cwd).length,
          cacheEntries: peekVerificationCache()?.stats().entries ?? null,
        },
        git: (() => {
          const repo = GitClient.gitMeta(cwd);
          return repo
            ? { available: true, branch: repo.branch, head: repo.head }
            : { available: false };
        })(),
        graph: {
          present: graph.present,
          stale: graph.stale,
          builtAt: graph.builtAt,
          nodes: graph.nodeCount,
          edges: graph.edgeCount,
        },
        runs: {
          lastRedAt: lastRed?.at,
          lastRedStep: lastRed?.step,
          lastGreenAt: lastGreen?.at,
        },
      };

      const report = buildDoctorReport(facts);
      return {
        content: [{ type: "text" as const, text: formatDoctorReport(report, facts) }],
        details: report,
      };
    },
  };
}
