import { defineConfig } from "./src/config.ts";

/**
 * Sentinel's own configuration.
 *
 * This file is deliberately explicit: it mirrors the defaults so that a reader
 * of this repo can see every switch in one place. All features are on by
 * default, including `autoRollback` — the guard is meant to feel like Codex /
 * Claude Code out of the box, not like a switchboard to assemble first.
 */
export default defineConfig({
  // ── master switches ────────────────────────────────────────────────────
  enabled: true,
  // A failing check restores the files that were changed. Destructive by
  // design: "bad code never pollutes the agent's context". The pre-state is
  // preserved as a checkpoint, so /sentinel rewind can still recover it.
  autoRollback: true,

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
