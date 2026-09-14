/**
 * StatusFormatting — compact, log-free summaries of what sentinel did.
 *
 * `/sentinel status` is read to answer three questions: is the guard armed,
 * what just ran, and how much has it been doing. Dumping the last twenty raw
 * verification records answers none of them well, so this module renders the
 * record as a short, scannable block.
 *
 * Pure: values in, lines out.
 */

import type { SentinelMetrics } from "../types.ts";

/** The shape of one persisted verification record (config.ts). */
export interface VerificationRecord {
  at: string;
  step: string;
  passed: boolean;
  exitCode: number;
  durationMs: number;
}

/** The shape of one persisted turn outcome (config.ts). */
export interface TurnRecord {
  at: string;
  turnIndex: number;
  passed: boolean;
  step?: string;
}

/** `420ms`, `2.4s`, `1m 04s` — short enough for a status line. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** `2026-09-13 13:06:20` from an ISO timestamp. */
export function formatStamp(iso: string): string {
  return iso.replace("T", " ").slice(0, 19);
}

/** Performance counters, as the "Performance" block of the status output. */
export function metricsLines(metrics: SentinelMetrics): string[] {
  const avg = metrics.checks > 0 ? Math.round(metrics.totalDurationMs / metrics.checks) : 0;
  const lines = [
    "Performance",
    `  checks:      ${metrics.checks} (${metrics.successes} ok / ${metrics.failures} failed)`,
    `  cache:       ${metrics.cacheHits} hit(s) / ${metrics.cacheMisses} miss(es)`,
    `  avg check:   ${formatDuration(avg)} | timeouts: ${metrics.timeouts}`,
    `  steps:       ${metrics.skippedSteps} skipped | ${metrics.retries} retried | ${metrics.escalations} escalated`,
    `  rollbacks:   ${metrics.rollbacks} (${metrics.partialRollbacks} partial)`,
    `  refused:     ${metrics.blockedWrites ?? 0} write(s) blocked | ${metrics.policyViolations} policy stop(s)`,
  ];
  return lines;
}

/** Newest-first one-liners: `✓ type-check 420ms`. */
export function verificationLines(records: VerificationRecord[], limit = 5): string[] {
  return records.slice(0, limit).map((record) => {
    const mark = record.passed ? "✓" : "✗";
    return `  ${mark} ${record.step}  ${formatDuration(record.durationMs)}`;
  });
}

/** Newest-first turn outcomes: `✓ turn #33`. */
export function turnHistoryLines(records: TurnRecord[], limit = 6): string[] {
  return records.slice(0, limit).map((record) => {
    const mark = record.passed ? "✓" : "✗";
    const detail = record.passed || !record.step ? "" : `  (${record.step})`;
    return `  ${mark} turn #${record.turnIndex}  ${formatStamp(record.at)}${detail}`;
  });
}
