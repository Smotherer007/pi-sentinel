import { defineConfig } from "./src/config.ts";

/**
 * Sentinel's own configuration.
 *
 * This file is deliberately explicit: it spells out every switch in one place.
 * Two deliberate exceptions to the library defaults exist *for this
 * repository*, both marked below: `autoRollback` is off, and so is
 * `revertOnRegression`. Everything else is on, including the three new P6
 * features (debounce, cache, escalation), which are opt-in in the library so
 * that upgrading never changes behaviour by surprise.
 */
export default defineConfig({
  // ── master switches ────────────────────────────────────────────────────
  enabled: true,

  // A failing check restores the files that were changed. Destructive by
  // design: "bad code never pollutes the agent's context". The pre-state is
  // preserved as a checkpoint, so /sentinel rewind can still recover it.
  //
  // Deliberately OFF while this repo itself is being worked on: a red
  // `npm run typecheck` in the middle of a refactor would otherwise undo edits
  // before they can be inspected. Everything else — the feedback loop, the
  // evidence ledger, checkpoints — stays on, so nothing is verified less.
  // Set back to `true` to arm the automatic restore again.
  autoRollback: false,

  // ── P0: close the loop ─────────────────────────────────────────────────
  // Turn-end failures re-prompt the agent instead of only notifying the human.
  // `recovery` is the canonical block; `autoFix` / `maxAutoRetries` are the
  // legacy spellings and are reconciled automatically.
  recovery: {
    enabled: true,
    maxAttempts: 3,
    // Off for this repo: the budget is still bounded, but a spent budget must
    // not silently undo a work-in-progress refactor.
    rollbackAfterExhaustion: false,
  },

  // ── P1: durable checkpoints ────────────────────────────────────────────
  checkpointRetention: 50,

  // ── P2: state-bound evidence ───────────────────────────────────────────
  trackVerifiedState: true,
  // Also deliberately OFF for the same reason as autoRollback: a multi-file
  // refactor is red between edits, and restoring the previous green revision
  // would silently undo the edit that was just made. The ledger still records
  // regressions and reports them — it just does not overwrite.
  revertOnRegression: false,
  pruneStaleTraces: true,

  // ── P3: out-of-band changes ────────────────────────────────────────────
  detectOutOfBand: true,

  // ── P4: revision contract ──────────────────────────────────────────────
  revisionContract: true,

  // ── P5: background checks & output budget ──────────────────────────────
  // Set false for a deterministic turn ending at the cost of latency.
  backgroundTurnEnd: true,
  maxOutputTokens: 2500,

  // ── P6: performance, cache & escalation ────────────────────────────────
  verification: {
    // Parallel edits in one assistant message become one type-check instead of
    // one per edit; sequential edits pay 150 ms of latency. `/sentinel verify`
    // and the `sentinel_verify` tool always bypass the window.
    debounceMs: 150,
    // A step that prints more than this is truncated head+tail before it can
    // reach the model. Not a toggle: it only bounds the damage.
    maxOutputBytes: 262144,
    // SIGTERM, then SIGKILL after this grace period, for the whole process tree.
    killGraceMs: 500,
    cache: {
      // Reuse a passing run for an identical code state. Keyed by file content,
      // lock/tsconfig content, step configuration, Node version and the
      // environment variables that can change a result.
      enabled: true,
      ttlMs: 300000,
      maxEntries: 50,
      persist: true,
    },
    failureEscalation: {
      // Three identical failures in a row mean the approach is wrong, not the
      // last edit — say so instead of letting the loop repeat itself.
      enabled: true,
      maxRepeatedFailures: 3,
    },
  },

  // ── P7: change policy (opt-in) ─────────────────────────────────────────
  // Off in the library and off here: gating the *shape* of a turn is a
  // deliberate per-project choice. Switch `enabled` on to refuse oversized
  // diffs or changes to sensitive files before they are verified.
  policy: {
    enabled: false,
    maxChangedFiles: 0,
    maxAddedLines: 0,
    allowPackageChanges: true,
    allowLockfileChanges: true,
    allowWorkflowChanges: true,
    sensitivePaths: [],
    rollbackOnViolation: false,
  },

  // ── mindplace synergy ─────────────────────────────────────────────────
  impactAwareFocus: true,

  maxTraceLines: 12,

  pipelines: {
    onFileMutation: [
      // Keep this group FAST — it runs after every edit/write. The project's
      // own script uses the locally installed TypeScript (no `npx` registry
      // lookup) and `--incremental`, so repeat runs only re-check changed
      // files. `files` restricts the step to the file types it can judge; a
      // step without `files` always runs.
      {
        name: "type-check",
        cmd: "npm run typecheck",
        timeoutMs: 60000,
        priority: "critical",
        files: ["**/*.ts", "**/*.tsx"],
      },
      // The linter is a warning: it must never fail a turn or trigger a
      // rollback, and projects without eslint stay usable.
      {
        name: "linter",
        cmd: "npx eslint --quiet",
        timeoutMs: 8000,
        priority: "warning",
        files: ["**/*.ts", "**/*.tsx"],
      },
    ],
    onTurnEnd: [
      // Slow, whole-project checks belong at turn end. Runs in the background
      // unless backgroundTurnEnd is disabled.
      //
      // `cacheable: false` on purpose: this suite is the slowest step in the
      // loop and the one whose result is least likely to be a pure function of
      // the file contents, so it is never served from the cache.
      {
        name: "unit-tests",
        cmd: "npm test",
        timeoutMs: 120000,
        priority: "critical",
        cacheable: false,
      },
    ],
  },

  include: ["**/*.ts"],
  exclude: ["**/node_modules/**", "**/.git/**", "**/*.md", "dist/**"],
});
