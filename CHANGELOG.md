# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

<!-- Add entries here. They are promoted into a version section when a release is cut. -->

## [2.1.0] - 2026-09-13

### Added
- **P6 — failure classification** (`src/formatting/classify.ts`): every failed step is labelled
  `type-error`, `lint-error`, `test-failure`, `build-failure`, `timeout`, `command-not-found`,
  `environment-error` or `unknown`, with a one-line error summary and a stable failure signature.
  The feedback now tells the agent what *kind* of problem it has, so a timeout or a missing binary
  no longer sends it off rewriting working source.
- **P6 — ranked, line-aware trace pruning** (`src/formatting/lines.ts`): compiler diagnostics and
  failing tests outrank stack frames, source locations outrank context, and download notices rank
  last. Context lines are kept only next to the diagnostic they belong to.
- **P6 — file-aware pipelines**: `PipelineStep.files` restricts a step to relevant changed files
  (e.g. `["**/*.ts"]`); no patterns means "always relevant", so existing configurations are
  unaffected. `PipelineStep.phase` restricts a step to `mutation` or `turn`.
- **P6 — verification coalescing** (`src/clients/queue.ts`): `verification.debounceMs` merges
  mutations that land within a fixed short window into a single verification. `/sentinel verify` and
  `sentinel_verify` bypass the window and take waiting requests with them.
- **P6 — verification cache** (`src/clients/cache.ts`): `verification.cache` reuses a *passing* run
  for a provably identical state (file contents, lock files, `tsconfig`, package.json, effective step
  configuration, Node version, result-relevant environment). Non-deterministic steps opt out with
  `cacheable: false`, which disables caching for that run.
- **P6 — retry policy for infrastructure failures**: `PipelineStep.retry`
  (`{ maxAttempts, retryOn, delayMs }`) retries only the kinds you list. Real compile and test
  failures are never retried.
- **P6 — repeated-failure escalation** (`src/clients/escalation.ts`): the same failure signature
  repeated `maxRepeatedFailures` times produces an explicit "do not repeat the same approach"
  message; a green run clears the counters.
- **P6 — performance metrics and a compact history**: `sentinel_status` and `/sentinel status` now
  report checks, cache hits/misses, average duration, timeouts, skipped/retried steps, escalations and
  rollbacks (partial ones included), plus a short per-turn history.
- **Rollback conflict detection**: the snapshot store records a post-mutation hash per file, so a
  rollback (and a durable checkpoint restore) refuses to overwrite a file that changed after the
  agent's own write, reports `ROLLBACK CONFLICT`, and marks the restore `partial`. Files the agent
  did not touch are still never overwritten.
- **Richer snapshot metadata**: pre-state `contentHash`, `size`, `mode` and `capturedAt`, restored
  mode included; binary and oversized files are covered by tests.
- **Process-tree termination**: steps run in their own process group and a timeout sends `SIGTERM`,
  then `SIGKILL` after `verification.killGraceMs`, so no child process survives a killed step.
- **Output budget per step** (`verification.maxOutputBytes`) and **secret redaction**
  (`src/formatting/redact.ts`): command output is truncated head+tail and stripped of credential
  values before it can reach the model; `/sentinel config` redacts configured `env` values.
- **`cwd` containment**: a step whose `cwd` resolves outside the project root fails with an
  environment error instead of running elsewhere.

### Changed
- **Behaviour-changing P6 features are opt-in**: `verification.debounceMs` defaults to `0`,
  `verification.cache.enabled` and `verification.failureEscalation.enabled` default to `false`, so an
  upgrade keeps the exact previous semantics until a project turns them on. The safety limits
  (`maxOutputBytes`, `killGraceMs`) are unconditional.
- `VerificationResult` gained `failureKind`, `timedOut`, `signal`, `errorSummary`, `affectedFiles`,
  `attempts`, `signature` and `priority`; `PipelineRunResult.steps` gained `skipped`, `cached`,
  `attempts` and `failureKind`.
- `PipelineStep.priority` (`critical` | `normal` | `warning`) supersedes `warnOnly`, which keeps
  working as the legacy spelling of `warning`.
- `sentinel_verify` never serves its result from the cache (an explicit request means "run the
  checks"), and `sentinel_rewind` reports conflicted files instead of claiming a full restore.
- `/sentinel status` reports metrics and a compact history instead of dumping raw records.

### Fixed
- An empty pipeline group no longer clears the repeated-failure escalation counters either; it runs
  after every edit and would otherwise make escalation impossible to reach.
- A killed verification step used to leave its children running (`child.kill()` signals only the
  shell), so a timed-out `jest` or compiler kept burning CPU after sentinel had reported the timeout.
- The verification cache can no longer reuse a result after a lock file, `tsconfig.json` or a
  result-relevant environment variable changed.

## [2.0.0] - 2026-09-13

### Added
- **P0 — the agent is re-prompted, not just reported to.** A red turn now sends the pruned
  failure back with `triggerTurn: true` (the equivalent of Claude Code's and Codex's `Stop`
  hook), bounded by `maxAutoRetries` and by a new stop condition: if the code state is
  identical to the one already re-prompted for, the loop stops instead of repeating itself.
  Only real user messages reset the repair budget, so sentinel's own continuations accumulate.
- **P1 — durable turn checkpoints** (`src/clients/checkpoints.ts`), flushed to disk at `turn_end`,
  with retention, code-graph labels, and the new `sentinel_rewind` tool plus `/sentinel rewind`
  menu (code only / code and conversation / conversation only / summarize from here). Checkpoints
  survive a session restart; the in-memory scope previously only ever covered the live turn.
- **P2 — state-bound evidence** (`src/clients/evidence.ts`): files that pass are hashed with a
  restorable copy, a later failure on a regressed file is reported as such, and with
  `revertOnRegression` that single file is restored. Older sentinel traces are marked superseded
  before every LLM call (`pruneStaleTraces`), addressing the measured #1 harm in repair loops
  (stale verification evidence).
- **P3 — out-of-band change detection** (`src/clients/workspace.ts`): `git status --porcelain`
  catches edits made by bash, formatters, generators and `git apply`, which the `edit`/`write`
  hooks cannot see, and verifies them too.
- **P4 — revision contract** (`src/prompt/contract.ts`): bounded-repair rules injected into the
  system prompt once per user turn.
- **P5 — background checks and an output budget**: `backgroundTurnEnd` runs the slow pipelines off
  the turn's critical path and re-wakes the agent on failure; `maxOutputTokens` caps the
  model-visible payload and spills the full output to a file.
- **Mindplace synergy** (`src/clients/mindplace.ts`): reads `graph-out/graph.json` to add the
  *blast radius* of a change to the failure payload, to promote diagnostics in dependents, and to
  label checkpoints with symbol names. Decoupled by design — no import of pi-mindplace, silent
  degradation without a graph.
- `sentinel_status` now reports checkpoints, verified states, code-graph availability and the
  auto-fix / regression history.

### Changed
- **Every feature is on by default**, including `autoRollback`. A project that wants the previous
  conservative behaviour sets `autoRollback: false` (and optionally the other flags) in
  `sentinel.config.ts`.
- `formatError` gained regression, impact, state-hash and retry-budget sections while keeping its
  ordering (trace → regressions → impact → advice → attempts).
- The failure payload is now built in one place (`src/formatting/feedback.ts`), so the hooks and
  `sentinel_verify` produce identical feedback.

### Fixed
- `loadConfig` cache-busted the config file by `mtime`, and Node's ESM loader caches by URL. On
  filesystems with coarse mtime resolution (CI containers, network mounts) two edits inside one tick
  therefore kept the *old* configuration alive, so sentinel verified with stale pipelines. The bust is
  now a content hash.
- The checkpoint store read its blobs from the wrong directory, so restoring a checkpoint silently
  skipped every file instead of writing it back.
- Regressions were detected *after* the automatic revert had already run, so a file that sentinel had
  just restored looked unremarkable in the feedback. Detection now happens first, and the payload says
  which files sentinel put back.
- A turn that changed nothing was compared against a different path set than the previous attempt, so
  the "delta stopped changing" stop condition never fired and the loop could re-prompt once more than
  necessary.
- An empty pipeline group no longer records verified-state evidence: it proves nothing, and claiming
  "verified" for it would be a lie.

## [1.2.0]

### Fixed
- `formatError` no longer claims the working tree was rolled back when
  `autoRollback` is off and the changes are still on disk.
- Globs are now matched against project-relative paths, so `exclude` patterns
  such as `dist/**` also catch absolute paths (previously reduced to a bare
  basename).
- `sentinel_verify`, `sentinel_rollback` and `sentinel_status` use the session
  `cwd` instead of `process.cwd()`, so they act on the correct repository.
- Pipeline subprocesses are killed on abort and run through the platform shell
  (`sh` on POSIX, `cmd.exe` on Windows) instead of assuming `sh` exists.
- `pruneTrace` caps output at exactly `maxLines` while keeping header/footer
  context, strips ANSI escape sequences and collapses duplicate lines.
- `warnOnly` failures are surfaced to the agent as warnings instead of being
  dropped silently.
- The package now exposes `main`/`exports`, so the documented
  `import { defineConfig } from "@patimweb/pi-sentinel"` resolves.

### Added
- Snapshot-based rollback (`src/clients/snapshot.ts`): the pre-state of every
  mutated file is captured before the mutation, so a failed check restores
  exactly those files — including newly created (untracked) ones — without
  touching unrelated uncommitted work.
- `include` config patterns now actually restrict which files trigger
  verification.
- Per-step `cwd`/`env` and per-project state scoping
  (`~/.pi/sentinel-state/<project>.json`).
- `sentinel_rollback` modes (`turn` | `head`) and a `force` escape hatch.

### Changed
- State is persisted once per pipeline run instead of once per step.
- A byte-identical rewrite skips verification entirely.

### Added
- Initial scaffold of `@patimweb/pi-sentinel`.
- In-loop verification guard (edit/write tool hooks).
- Configurable validation pipelines (`tsc`, `eslint`, tests) with timeouts.
- AST/RegEx trace pruning to keep error output token-efficient.
- Git working-tree rollback on invariant violation.
- Tools: `sentinel_verify`, `sentinel_rollback`, `sentinel_status`.
- `/sentinel` command with `status`, `verify`, `test`, `rollback`, `config`.
- `sentinel.config.ts` config manifest with `defineConfig` helper.
- Atomic, permission-safe state persistence (`~/.pi/sentinel-state.json`).
- Semantic-release pipeline config + GitHub Actions CI.
