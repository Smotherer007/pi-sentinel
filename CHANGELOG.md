# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

<!-- Add entries here. They are promoted into a version section when a release is cut. -->

## [2.2.1] - 2026-09-13

### Fixed
- **Data safety — an unreadable file is never deleted.** A read failure (`EACCES`/`EPERM`/`ELOOP`/…)
  was recorded as "did not exist", so a rollback removed the file. Only a genuine absence
  (`ENOENT`/`ENOTDIR`) now leads to a delete; anything unreadable is skipped and reported.
- **Data safety — a symlink is never turned into a regular file.** Symlinks are recorded as
  incomplete, so a restore skips them instead of destroying the link while leaving the target
  changed.
- **A regression revert can no longer overwrite foreign work.** A file is reverted only when the
  agent itself wrote it this turn *and* it still matches the agent's post-mutation hash; regression
  detection is scoped the same way, so a user's uncommitted edit is neither overwritten nor
  attributed to the agent.
- **A skipped step no longer counts as evidence.** A step filtered out by `phase`/`files` still
  appeared in `run.steps`, so a run that proved nothing could be recorded as a verified state
  (and could then be reported as a regression).
- **An invalid `timeoutMs` is refused instead of faked as a timeout.** `0`, negative, `NaN`,
  `Infinity` and a missing value all collapse to a ~1 ms timer, which reported healthy checks as
  timeouts and could roll back a good change. The step now fails as an environment error, values
  above the 32-bit timer range are clamped, and `configProblems` warns at load time without
  silently repairing the value.
- **A negative `maxOutputBytes` can no longer grow the output buffer.** The head/tail math doubled
  the buffer on every chunk; a non-usable cap falls back to the documented default.
- **A partial restore is reported as an unknown state.** Files the rollback could not restore
  (oversized, unreadable or symlinked) are surfaced explicitly (`RESTORE INCOMPLETE … state
  UNKNOWN`) instead of the message claiming the changes are still in place.
- **A background check that outlives its input is discarded.** If the code changes while a
  background `onTurnEnd` run is in flight, the result is reported to the human but never used to
  re-prompt the agent or restore files.
- **A path named `..foo.ts` is no longer skipped** by the project-scope check, and a change-policy
  stop now keeps its rewind checkpoint.

### Tests
- Regression tests for unreadable files, symlink preservation, skipped-step evidence, foreign-work
  protection, invalid timeouts, the output cap, partial-restore reporting and stale background
  results.

## [2.2.0] - 2026-09-13

### Added
- **P7 — change policy** (`src/clients/policy.ts`): an opt-in, per-turn diff policy that gates the
  *shape* of a change rather than its result — `maxChangedFiles`, `maxAddedLines`,
  `allowPackageChanges`, `allowLockfileChanges`, `allowWorkflowChanges` and custom
  `sensitivePaths`. A violation is a structured stop the agent has to answer, with optional
  `rollbackOnViolation`, an identical-violation guard and an audit trail in `sentinel_status`.
  Disabled by default, so upgrading never blocks an existing workflow.
- **Bounded recovery** (`recovery`): the canonical spelling of `autoFix` / `maxAutoRetries`, plus
  `rollbackAfterExhaustion` to restore the state before the failing cycle. The legacy keys are
  reconciled in both directions, so an existing configuration keeps its exact attempt budget.
- **`PipelineStep.maxTraceLines`**: per-step override for the pruner's critical-line budget.

### Changed
- **An automatic rollback never widens into `git checkout -- .`.** With no snapshot captured it is an
  explicit no-op that reports `method: "none"`, instead of discarding unrelated uncommitted work; the
  explicit `sentinel_rollback` `mode: "head"` reset remains available.
- **Snapshot restores are atomic**: content is written to a sibling temp file and renamed, so a crash
  or a full disk cannot leave a half-written source file.
- **Verification and persistence failures no longer end a session**: a throwing runner is reported and
  the turn continues, and failing to persist state is a warning, not an exception.
- `/sentinel status` and `sentinel_status` report `recovery` and `policy` separately from the legacy
  aliases, and list recent policy violations.

### Fixed
- Change-policy `sensitivePaths` globs are matched project-relative, like `include`/`exclude`; an
  anchored pattern previously never matched.
- `rollbackAfterExhaustion` now actually restores the pre-cycle state: the restore is no longer
  refused by the "modified since the checkpoint" guard that the intermediate attempts itself triggered.
- Out-of-band detection retries `git status` once instead of silently returning no changes, so a
  transient failure can no longer disable P3 for a whole turn.

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
- The coalescing window and the SIGKILL escalation timer are no longer `unref`'d. A pending window is
  the only thing that can resolve a queued verification, so letting the event loop drop it left the
  caller's promise unsettled (a runner that ended as soon as the loop drained cancelled every
  debounced test — caught by CI, guarded by a child-process test).
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
