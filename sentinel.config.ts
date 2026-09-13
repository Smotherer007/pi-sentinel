import { defineConfig } from "./src/config.ts";

/**
 * Sentinel's own configuration.
 *
 * This file is deliberately explicit: it spells out every switch in one place,
 * at the library's defaults. The single deliberate exception is `autoRollback`,
 * which is off *for this repository* (see below). Elsewhere the guard is meant
 * to feel like Codex / Claude Code out of the box, not like a switchboard to
 * assemble first.
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
  autoFix: true,
  maxAutoRetries: 3,

  // ── P1: durable checkpoints ────────────────────────────────────────────
  checkpointRetention: 50,

  // ── P2: state-bound evidence ───────────────────────────────────────────
  trackVerifiedState: true,
  revertOnRegression: true,
  pruneStaleTraces: true,

  // ── P3: out-of-band changes ────────────────────────────────────────────
  detectOutOfBand: true,

  // ── P4: revision contract ──────────────────────────────────────────────
  revisionContract: true,

  // ── P5: background checks & output budget ──────────────────────────────
  // Set false for a deterministic turn ending at the cost of latency.
  backgroundTurnEnd: true,
  maxOutputTokens: 2500,

  // ── mindplace synergy ─────────────────────────────────────────────────
  impactAwareFocus: true,

  maxTraceLines: 12,

  pipelines: {
    onFileMutation: [
      // Keep this group FAST — it runs after every edit/write. The project's
      // own script uses the locally installed TypeScript (no `npx` registry
      // lookup) and `--incremental`, so repeat runs only re-check changed
      // files.
      { name: "type-check", cmd: "npm run typecheck", timeoutMs: 60000 },
    ],
    onTurnEnd: [
      // Slow, whole-project checks belong at turn end. Runs in the background
      // unless backgroundTurnEnd is disabled.
      { name: "unit-tests", cmd: "npm test", timeoutMs: 120000 },
    ],
  },

  include: ["**/*.ts"],
  exclude: ["**/node_modules/**", "**/.git/**", "**/*.md", "dist/**"],
});
