# pi-sentinel

Astra/Codex-style in-loop verification, repair & rollback hardening for the [pi coding agent](https://github.com/earendil-works/pi).

Sentinel turns every failed check into a self-correcting signal instead of a dead end: it prunes failed
tool-execution traces (saving tokens), runs configured validation pipelines (`tsc`, `eslint`, tests),
remembers which code states actually passed, and restores the files it changed when invariant
violations are detected — so bad code never pollutes the agent's context.

**All features are on by default.** A fresh project gets, without writing a config file, the same
mechanisms Codex CLI and Claude Code rely on:

| | Codex CLI | Claude Code | pi-sentinel |
|---|---|---|---|
| Failure fed back into the loop | `PostToolUse` → `decision: "block"` replaces the tool result | `PostToolUse` → `additionalContext` / `updatedToolOutput` | `tool_result` prepends the pruned trace and sets `isError` |
| **Turn end re-prompts the agent** | `Stop` → `decision: "block"` creates a continuation prompt | `Stop` → conversation continues on `decision: "block"` | **`turn_end` → `pi.sendMessage(…, { triggerTurn: true })`**, bounded |
| Loop guard | `continue: false` | `stop_hook_active` | **budget + "code state unchanged" stop condition** |
| Code checkpoints | git checkpoints (manual) | checkpointing + `/rewind`, last 100, ~30 days | **durable turn checkpoints + `/sentinel rewind`**, retention 50 |
| Rollback precision | git stash | skips bash edits, subagents, symlinks | **snapshots incl. newly created files**, unrelated work untouched |
| Detects bash/formatter/git edits | sandbox-wide | documented blind spot | **`git status --porcelain` scan against a per-turn baseline (P3)** |
| Refuses a bad write before it happens | approval modes | `PreToolUse` → `deny` | **`tool_call` → `block` for protected paths and repair scope (P8)** |
| Survives context compaction | — | `PreCompact` hook | **`session_compact` restates the invariants, budget carries over (P8)** |
| Environment failure ≠ code failure | sandbox reports it | — | **timeout / missing tool / env error never rolls back (P6)** |
| Stale verification traces | bounded retries, delta check | — | **superseded traces before every LLM call (P2)** |
| Verified-state memory | hook recipe | — | **content-hash ledger + regression revert (P2)** |
| Impact / blast radius | — | — | **code knowledge graph via pi-mindplace** |
| Bounded output | ~2,500 tokens + spill file | 10,000 chars + spill file | **`maxOutputTokens` + spill file (P5)** |
| Long checks off the critical path | background hooks | `asyncRewake` | **background turn-end + re-wake (P5)** |

## Requirements

Node **22.18 or newer**. The package ships TypeScript sources and relies on Node's native type
stripping, so an older runtime fails at import with an unexplained syntax error. This is declared as
`engines.node` — `npm install` will warn you rather than let you find out at run time.

## Installation

```bash
# Install from npm
pi install npm:@patimweb/pi-sentinel

# Install from a local checkout during development
pi install /path/to/pi-sentinel
```

Optional but recommended: install [`pi-mindplace`](https://github.com/Smotherer007/pi-mindplace) in the
same project and build its graph (`mindplace_build`). Sentinel then knows the *blast radius* of every
change — see [Synergy with pi-mindplace](#synergy-with-pi-mindplace).

## How it works

```
                              pi Agent Loop
   ┌───────────────────────────────────────────────────────────────────────────┐
   │  edit / write                        end of agent turn                     │
   └──────────────────┬──────────────────────────────┬────────────────────────┘
   tool_call: status  │                              │  turn_end
   "Mutation detected"│                             │  ├─ P1 flush checkpoint
   ─→ verifying…      │                              │  ├─ P3 scan git working tree
                      ▼                              │  ├─ P5 background checks
   ┌───────────────────────────────────────────────────────────────────────────┐
   │                            Sentinel Guard                                 │
   │                                                                           │
   │   onFileMutation ─→ type-check          onTurnEnd ─→ unit-tests           │
   │                                                                           │
   │   PipelineRunner: subprocess · timeout · buffered output · spill          │
   └───────────────────────────┬───────────────────────────────────────────────┘
                               │
              ┌────────────────┴─────────────────┐
              ▼                                  ▼
     all steps exit 0                    some step exits ≠ 0
     (checks passed)                    (checks failed)
              │                                  │
              │                    ┌─────────────┴──────────────┐
              │                    ▼                            ▼
              │        P2 record verified hashes     TracePruner → PrunedFeedback
              │        (verified.json + blobs)       + P2 regressed verified files
              │        P0 reset repair budget        + mindplace impact section
              │        P5 clear status               + P5 output budget
              │                                      │
              │                    ┌─────────────────┴───────────────────┐
              │                    ▼                                     ▼
              │          autoRollback && !warnOnly ?            P0 autoFix ?
              │                    │                                     │
              │         yes ───────┴────── no                 inject ────┴──── stop
              │          ▼                    ▼                  ▼              ▼
              │   restore mutation     P2 revert the      pi.sendMessage    notify the
              │   or whole turn        regressed files    (triggerTurn)     human, stop
              │          │                    │                  │
              └──────────┴────────────────────┴──────────────────┘
                                          │
                                          ▼
                        trace is injected back into the loop
                        (tool_result isError, or a follow-up turn)
```

### A worked example: sentinel as a safety layer

The shape is the same whether you drive pi interactively or from a script: the agent edits freely,
sentinel is the last line of defence, and every red state has a defined way out.

```ts
// sentinel.config.ts — safety-layer profile
import { defineConfig } from "@patimweb/pi-sentinel";

export default defineConfig({
  autoRollback: false,             // do not silently undo work in progress
  recovery: {
    enabled: true,
    maxAttempts: 3,                // bounded repair loop
    rollbackAfterExhaustion: true, // …then return to the pre-cycle state
  },
  policy: {
    enabled: true,                 // refuse the wrong *shape* of change, too
    maxChangedFiles: 15,
    maxAddedLines: 600,
    allowWorkflowChanges: false,
    sensitivePaths: [".env", "secrets/**"],
    rollbackOnViolation: true,
  },
  pipelines: {
    onFileMutation: [
      { name: "type-check", cmd: "npm run typecheck", timeoutMs: 60000, priority: "critical", files: ["**/*.ts"] },
    ],
    onTurnEnd: [
      { name: "unit-tests", cmd: "npm test", timeoutMs: 120000, priority: "critical", cacheable: false },
    ],
  },
});
```

A single turn then looks like this:

```text
agent edits src/foo.ts
  → onFileMutation: type-check               (fast; result returned with the edit)
turn ends
  → onTurnEnd: unit-tests                    (full suite)
       PASS → verified state recorded; recovery budget reset
       FAIL → agent re-prompted with the pruned failure      (attempt 1/3)
              … still red after 3 attempts?
              → restore the files changed since the first attempt
              → report to the human: "recovery exhausted"
```

What that buys you: unrelated uncommitted work is never touched, a repair loop cannot run forever,
a spent budget cannot leave a half-finished edit behind, and a change that would rewrite CI or a
lockfile is stopped before it is ever verified.

## The nine mechanisms

### P0 — close the loop: the agent is re-prompted, not just reported to

Claude Code's `Stop` hook and Codex's `Stop` hook both do the same thing on a failed check: they make
the agent **continue** with the failure as input. Sentinel now does too. When a turn ends red, the
pruned failure is sent as a message with `triggerTurn: true`, so the agent gets a new turn to fix it.

The loop is bounded, and the stop conditions follow Codex's own repair-loop guidance ("a good loop
stops for one of four reasons"):

| Stop condition | Implementation |
|---|---|
| checks pass | budget reset |
| retry budget exhausted | `recovery.maxAttempts` (default 3) |
| **the delta stops changing** | the code-state hash is identical to the one already re-prompted for |
| a real user prompt arrives | budget reset (only `role: "user"` messages reset it — sentinel's own continuations do not, otherwise the loop would be unbounded) |

```ts
recovery: {
  enabled: true,                   // re-prompt the agent with the failure
  maxAttempts: 3,                  // consecutive attempts before the loop stops
  rollbackAfterExhaustion: false,  // restore the state before the failing cycle
},
```

`autoFix` and `maxAutoRetries` are the older spelling of `enabled` and `maxAttempts`. Sentinel
reconciles the two in both directions, so an existing configuration keeps its exact attempt budget —
but `recovery` is the canonical block. With `rollbackAfterExhaustion` on, spending the budget
restores the checkpoint from **before the first turn of the failing cycle**, not merely the last edit,
so neither the agent nor the user inherits a half-finished change. That restore bypasses the
"modified since the checkpoint" guard on purpose: the conflict it would report is the agent's own
intermediate attempt, which is exactly what is being discarded.

Evidence of the "delta stops changing" rule in the payload:

```
[sentinel] Verification failed at step "type-check"
exit code: 2 | duration: 5321ms
state: a1b2c3d4e5f6
────────────────────────────────────────────────────────────
src/config.ts(27,14): error TS2740: Type '…' is missing the following properties…
────────────────────────────────────────────────────────────
Your changes are still in place. Fix the reported error; do not repeat the same edit.
Repair attempt 2/3. After 3, stop and report what still fails instead of editing again.
```

### P1 — durable checkpointing and `/sentinel rewind`

The in-memory snapshot scope is dropped at `turn_end`, so the original sentinel could only undo the
turn that was *currently* running. Turn checkpoints are now flushed to disk, which is what Claude
Code's checkpointing buys you: undo an earlier turn, or one from before a session restart.

```
~/.pi/sentinel-state/<project>-<hash>/checkpoints/<seq>-<id>/manifest.json
~/.pi/sentinel-state/<project>-<hash>/checkpoints/<seq>-<id>/blobs/<n>.blob
```

- Retention: `checkpointRetention` (default **50**), oldest pruned automatically.
- Checkpoints are labelled with **symbol names from the code graph**, so the list reads like a changelog.
- Restoring writes back exactly the files that turn touched — files the turn never touched (including
  your own uncommitted work) are never modified.
- Files the turn **created** are deleted again on restore; files larger than 4 MB are skipped and the
  restore is reported as *partial*.

Tools and commands:

```bash
sentinel_rewind({ mode: "list" })                  # inspect: id, time, turn, label
sentinel_rewind({ mode: "code" })                  # restore the newest checkpoint
sentinel_rewind({ mode: "code", checkpointId: "7" })  # or a specific one
```

```
/sentinel rewind      # interactive menu
  → Code only                  restore the working tree
  → Code and conversation      restore the tree and move the session tree back
  → Conversation only          rewind the conversation, keep the code
  → Summarize from here        compress the turn away into a summary
```

Conversation rewind needs session-tree navigation, which is only available to commands — that is why
it lives in `/sentinel rewind` and not in the tool.

### P2 — state-bound evidence

This is the mechanism with the hardest evidence behind it. Forcing extra revisions **lowered**
correctness by 14.7 percentage points in a 900-trajectory study (correctness after 1 revision: 82.0 %;
after 2: 67.3 %), and *stale verification traces* were the primary cause (arXiv 2607.24604). Sentinel
therefore binds evidence to the code state that produced it.

**Verified-state ledger.** Every file that passes is hashed, with a restorable copy:

```
~/.pi/sentinel-state/<project>-<hash>/verified.json
~/.pi/sentinel-state/<project>-<hash>/verified-blobs/<pathhash>-<contenthash>.blob
```

When a later check fails on a file that was green at a different hash, sentinel says so instead of
repeating an error the agent already failed to fix:

```
Regressed from a verified state (1 file(s)):
  • src/config.ts — was green at 2026-09-13 09:07:38 (onTurnEnd:unit-tests)
    current: bbbbbbbbbbbb vs verified: aaaaaaaaaaaa
```

With `revertOnRegression: true` (default), that single file is restored to the verified state — a
narrower operation than a turn rollback, because it leaves the rest of the turn's work alone.

**Superseded traces.** Before every LLM call sentinel keeps only its newest failure trace live and
rewrites older ones to *"superseded by a later run — ignore it"*. This is the direct countermeasure to
the measured harm, and it cannot be done with a single tool result.

```ts
trackVerifiedState: true,
revertOnRegression: true,
pruneStaleTraces: true,
```

### P3 — out-of-band changes are seen

Sentinel only observes `edit` and `write`. A large share of real edits does not travel through them:
`sed -i`, a formatter, `git apply`, a code generator, `npm run fix`. Claude Code's checkpointing has
the same blind spot and documents the workaround — ask the working tree itself, via
`git status --porcelain`, which also lists untracked files that `git diff` misses.

At `turn_start` sentinel fingerprints everything the working tree already reports as dirty. At
`turn_end` it scans again, subtracts the paths the hooks captured *and* everything that was already
dirty before the turn began, and verifies the remainder:

```ts
detectOutOfBand: true,
```

Both halves of that matter more than they look:

- **The working tree is not a diff.** `git status` lists every uncommitted change, not the ones this
  turn made. Without the baseline, a user's work in flight is attributed to the agent — and since the
  focus set feeds `stateHashOf`, the hash that bounds the repair loop starts drifting with files
  nobody in this turn touched. The loop's stop condition depends on that hash being stable, so this
  is a correctness property, not a tidiness one.
- **Porcelain paths are repository-root-relative**, never relative to the current directory. Running
  the agent in a package inside a monorepo is completely ordinary, and resolving those paths against
  the cwd yields paths that do not exist. Every git-derived path now goes through
  `git rev-parse --show-toplevel`, mapped back through the caller's own (possibly symlinked) prefix
  so it still matches the absolute paths the mutation hooks captured.

Caveat, stated honestly: out-of-band files are **verified but not snapshotted** — their pre-state was
never observed, so they cannot be restored from a checkpoint. Sentinel reports how many files that
affects.

### P4 — a revision contract in the system prompt

Rules in a prompt are cheaper than guard rails in code. Once per user turn sentinel appends a short
contract (scoped to that turn, never accumulating):

```
[sentinel:revision-contract] active in this repository:
- A green check is evidence. Do not rewrite code whose checks just passed unless the user asked for exactly that change.
- At most 3 repair attempts per failing check. If the last attempt fails again, stop and report what you tried and what still fails — do not keep editing.
- Never state that a check passes unless you ran it in this turn (the step's own command, or `sentinel_verify`).
- If sentinel reports that a file regressed from a verified state, either restore that file or justify the change explicitly.
- When sentinel lists dependents from the code graph, treat them as the blast radius: fix the cause in place, then check the dependents it names.
- When the same failure comes back 3 times, stop varying the same edit: re-read the code and change the approach.
```

The last rule is added when `verification.failureEscalation.enabled` is on, with the configured
threshold; the `revertOnRegression` rule is added when evidence tracking is on, and so on — the
contract only states rules that the active configuration can actually enforce.

```ts
revisionContract: true,
```

### P5 — background checks and an output budget

**Background.** Blocking a turn on a 40-second test suite is a bad trade. With `backgroundTurnEnd`
(default on) the turn ends immediately, the checks run in the background, and a failure re-wakes the
agent through the same P0 path. Rollback is only attempted while the failed turn is still the newest
checkpoint — if the agent already produced a newer turn, restoring the old state would silently
discard work the user has not seen yet, so sentinel reports instead.

**Output budget.** Codex caps model-visible hook output at roughly 2,500 tokens and spills the rest to
a file with a head/tail preview; Claude Code does the same at 10,000 characters. Unbounded compiler or
test output is the fastest way to burn a context window on noise:

```
… [sentinel: output truncated to 2500 tokens — full output: ~/.pi/sentinel-state/<project>/spills/2026-09-13T09-07-38-259Z-type-check.log]
```

```ts
backgroundTurnEnd: true,
maxOutputTokens: 2500,   // 0 disables the cap
```

### P6 — coalescing, classification, cache and escalation

The loop-level optimisations. All four are **opt-in in the library** (defaults
`debounceMs: 0`, `cache.enabled: false`, `failureEscalation.enabled: false`) so
that upgrading sentinel never changes behaviour by surprise; this repository
turns all of them on.

**Coalescing (`verification.debounceMs`).** Four `edit` calls in one assistant
message produce four `tool_result` hooks within a few milliseconds. With a
window configured, they become *one* verification whose scope is the union of
the edits. The window is fixed — it is not extended by later arrivals — so the
latency a caller can experience is bounded. An explicit `/sentinel verify` or
`sentinel_verify` always runs immediately and takes any waiting requests with it.

**Failure classification (`src/formatting/classify.ts`).** Every failure is
labelled `type-error`, `lint-error`, `test-failure`, `build-failure`, `timeout`,
`command-not-found`, `environment-error` or `unknown`. The label decides what the
agent is told to do: a timeout or a missing binary must *not* send it off
rewriting working code.

**Verification cache (`src/clients/cache.ts`).** A passing run is reused only
when the question is provably the same: keyed by the content of every changed
file, the content of `package*.json`/lock files/`tsconfig.json`, the effective
step configuration, the Node version and the environment variables that can
change a result. Two rules keep it honest — **only passing runs are cached**, and
a step marked `cacheable: false` disables caching for the whole run (which is
what non-deterministic test suites get).

**Failure escalation (`src/clients/escalation.ts`).** The same failure signature
(`kind` + the first diagnostic lines) repeated `maxRepeatedFailures` times means
the *approach* is wrong, not the last edit:

```
Repeated verification failure detected.
The same error occurred 3 time(s) (threshold 3). Do not repeat the same approach
— re-evaluate the implementation before editing again.
```

A genuinely green run clears the counters.

### P7 — change policy: green code can still be the wrong change

Verification answers *"does it work?"*. A change policy answers a different question: *"is this the
kind of change that was supposed to happen?"* — twenty unrelated files, a 500-line diff, or a
rewritten CI workflow can all be green and still be a serious mistake. Codex and Claude Code both
gate this class of change behind an explicit approval; sentinel turns it into a structured stop the
agent has to answer.

The policy is **disabled by default** (`policy.enabled: false`) so upgrading never blocks an existing
workflow. When enabled, it measures the shape of a turn and refuses it *before* anything is verified
or persisted:

| Rule | Fires on |
|---|---|
| `maxChangedFiles` | more than N files in one turn (`0` = unlimited) |
| `maxAddedLines` | more than N added lines in one turn (`0` = unlimited) |
| `allowPackageChanges` | a `package.json` was modified |
| `allowLockfileChanges` | a lockfile (`package-lock.json`, `yarn.lock`, …) was modified |
| `allowWorkflowChanges` | anything under `.github/workflows/` was modified |
| `sensitivePaths` | a configured glob was modified (always forbidden) |

```ts
policy: {
  enabled: true,
  maxChangedFiles: 12,         // 0 = no limit
  maxAddedLines: 400,          // 0 = no limit
  allowPackageChanges: true,
  allowLockfileChanges: false,
  allowWorkflowChanges: false,
  sensitivePaths: ["secrets/**", "**/*.pem"],
  rollbackOnViolation: true,   // restore the turn's files when it violates
},
```

A violation is a hard stop with a machine-readable explanation, so the agent is told exactly what to
revert rather than a count it cannot act on:

```
[sentinel] Change policy violation — the turn was not accepted.

Change summary:
  files changed: 3 (added 1, modified 2, deleted 0)
  lines added:   412 | lines removed: 8
  sensitive:     .github/workflows/ci.yml (workflow)

Violations:
  • Policy violation: 412 lines were added, but at most 400 are allowed per turn.
  • Policy violation: .github/workflows/ci.yml may not be modified.

Revert the offending change (use `sentinel_rollback` or edit the file back). If the change is
intended, the user must relax the policy in sentinel.config.ts.
```

The engine is pure (`src/clients/policy.ts`): it receives the before/after content of every changed
file and returns counts plus violations, so the rules are unit-tested without a repository. Line
stats come from a bounded LCS diff — exact for anything a human reviews, and deliberately
over-reporting rather than under-reporting beyond the budget, because a policy whose job is to stop
large changes must never miss one. Two rules keep the stop honest:

- A path whose pre-state was never captured (a bash-only change) is still treated as changed, so a
  shell-driven deletion of a protected file cannot slip past the policy.
- The **identical** violation (same offending state, same rule) is reported to the human but never
  re-sent to the agent, which is what keeps a policy stop from becoming a loop of its own. A clean
  turn reopens the stop, so a later occurrence is reported again.

### P8 — the context is the product, so it is defended

The three mechanisms above (P0, P2, P4) all rest on one assumption: that what the agent reads about
the code is bound to the code as it is. Three things break that assumption, and each gets an answer.

**A write that should never happen is refused, not undone.** `tool_call` can return
`{ block: true, reason }` — pi's equivalent of Claude Code's `PreToolUse` deny. Sentinel uses it for
two cases: a path the change policy protects, and an edit that reaches outside the file set the
current repair cycle is about. The agent reads the reason as a tool error and can act on it; nothing
was written, so there is nothing to restore and no conflict to resolve:

```ts
policy: { enabled: true, allowWorkflowChanges: false, blockBeforeWrite: true },
recovery: { scopeGuard: "block" },
```

The turn-end policy evaluation still runs. It is the only thing that can see a change made through
bash rather than `edit`/`write`, so the two are complementary rather than redundant.

**A repair cycle may not widen.** The first failing turn of a cycle fixes the file set that cycle is
about. A later attempt that edits something else is not repairing the cause, it is varying an
approach — the documented way these loops turn one failure into several. `scopeGuard: "report"`
(the default) names the offending files in the failure payload; `"block"` refuses the edit outright.
A new user message opens a fresh cycle, because the user asking for something else is not a widening
repair.

**A compaction does not launder stale evidence.** Compaction replaces the conversation with a
summary, and everything sentinel relies on being *in* the context goes with it: the contract, the
live trace, the list of what is green. What survives is prose — and a summarized "the tests passed"
is exactly the unbound evidence that sends a repair loop after code that has already moved. On
`session_compact` sentinel restates the invariants as facts, re-lists the files that are verified
green *at their current content*, and explicitly disowns any check result recalled from the summary.

The repair budget deliberately carries across the compaction. A loop that could buy itself fresh
attempts by triggering one would not be bounded at all.

## Tools

| Tool | Description |
|------|-------------|
| `sentinel_verify` | Run verification pipelines on demand (`trigger: "mutation" \| "turn"`). Records evidence on success, reports regressions and graph impact on failure, optionally restores. |
| `sentinel_rollback` | Restore the files changed this turn (`mode: "turn"`, safe default), or hard-reset tracked files to HEAD (`mode: "head"`, destructive, needs `force` unless `autoRollback` is on). |
| `sentinel_rewind` | List or restore durable turn checkpoints (`mode: "list" \| "code"`). Works beyond the current turn and across restarts. |
| `sentinel_status` | Active config, git state, checkpoints, verified states, code-graph status, and the rollback / auto-fix / regression / verification history. |

## Commands

| Command | Description |
|---------|-------------|
| `/sentinel` | Show help. |
| `/sentinel status` | Show current state. |
| `/sentinel verify` | Run `onFileMutation` pipelines now. |
| `/sentinel test` | Run `onTurnEnd` pipelines now. |
| `/sentinel rollback` | Restore this turn's changes, or reset to HEAD. |
| `/sentinel rewind` | Menu: restore code, conversation, both, or summarize. |
| `/sentinel config` | Dump the active (merged) configuration. |

## Rollback model

Sentinel snapshots the pre-state of every file the agent touches in the `tool_call` hook — *before* the
mutation runs — and keeps it in a per-turn journal. On a critical failure it restores exactly those
files, in this order of preference:

1. **Mutation failure** (`onFileMutation`) → only the offending mutation's files.
2. **Turn failure** (`onTurnEnd`) → every file touched during the turn, including files the agent
   **newly created** via `write`.
3. **Regressed verified file** (P2) → that single file, restored from `verified-blobs/`.
4. **Checkpoint restore** (P1) → any earlier turn, by id, from `checkpoints/`.
5. **`git checkout -- .`** → only as a fallback when no snapshot was captured, or for an explicit
   `mode: "head"`.

Guarantees and limits, stated plainly:

- **Untouched files are never modified**, so unrelated uncommitted work survives.
- Files larger than **4 MB** are not snapshotted; a restore touching such a file is reported as *partial*.
- **Bash-made changes cannot be rolled back** from a snapshot — their pre-state was never observed.
  They are verified (P3) and the limitation is reported; use git for those.
- `mode: "head"` is the only destructive operation, and it is gated behind `force` while
  `autoRollback` is off.
- **`autoRollback: true` is on by default**, which means a failing check restores the files the agent
  changed. If you prefer to keep broken work in place and repair it by hand, set it to `false` — the
  feedback loop (P0) still runs.

## Performance

The rule is simple: **mutation checks must be fast, expensive checks belong in
`onTurnEnd`.**

```
Mutation (after every edit/write)        Turn end (once per turn)
├── syntax                              ├── complete test suite
├── type-check (incremental)            ├── build
└── lightweight lint (warning)          ├── integration tests
                                        └── expensive checks
```

What keeps the mutation path cheap, in order of effect:

1. **File-aware steps.** A step with `files: ["**/*.ts"]` is skipped entirely when only Rust or
   Markdown changed. No patterns means "always relevant", so old configurations keep working.
2. **Coalescing.** `debounceMs` merges edits that land together into one run.
3. **The cache.** An identical code state is not re-checked; `cacheable: false` opts a step out.
4. **Background turn-end checks.** `backgroundTurnEnd` keeps the slow group off the critical path.
5. **A bounded output buffer.** A runaway process cannot fill the context window.

`/sentinel status` (and the `sentinel_status` tool) reports the counters:
checks, cache hits/misses, average duration, timeouts, skipped/retried steps,
escalations and rollbacks.

## Safety

These rules are not configurable, and they are the reason the rollback path is
trustworthy:

1. **Nothing unrelated is ever overwritten.** Restores are file-based, from a
   snapshot taken in `tool_call` — before the mutation. `git checkout -- .` is
   never used while a snapshot exists, and untracked files the agent did not
   create are never touched.
2. **A file that changed after the agent's mutation is not restored.** Sentinel
   records a hash of what the agent's write left on disk; if the file no longer
   matches it, somebody else wrote it (a formatter, another process, the user)
   and the rollback reports a conflict instead of overwriting:

   ```
   ROLLBACK CONFLICT (1 file(s)) — NOT overwritten:
     src/foo.ts was modified after the Sentinel snapshot.
       expected: 3f9a1c2b7d4e | current: 91b4d0aa77c1
     The file was NOT overwritten. Manual recovery required.
   ```

   The rollback is then `partial`, `/sentinel rewind` reports the same way, and
   the conflict is shown to the agent instead of hidden from it. An explicit,
   user-requested overwrite is possible (`force`), which is what the destructive
   `mode: "head"` reset is for.
3. **Secrets never reach the model.** Step output is passed through
   `redactSecrets` (values of credential-looking environment variables plus
   well-known key shapes) before it leaves the runner, and `/sentinel config`
   redacts configured `env` values.
4. **A timeout kills the process tree.** Steps run in their own process group;
   `SIGTERM` is followed by `SIGKILL` after `killGraceMs`, so no `sleep`, `jest`
   or compiler keeps burning CPU after sentinel has already reported the timeout.
5. **Output and runtime are bounded.** `maxOutputBytes` per step, `timeoutMs` per
   step, `maxOutputTokens` for the model-visible payload.
6. **A `cwd` cannot leave the project root.** A step whose `cwd` resolves outside
   it fails with an environment error rather than running elsewhere.
7. **An environment failure never costs you code.** A timeout, a missing binary
   or an `EACCES`/network error says nothing about what you wrote. Those kinds
   never trigger a rollback, never revert a regression and never spend a repair
   attempt — sentinel already tells the agent "do not rewrite working code for
   this", and doing the opposite would make that advice a lie.
8. **A turn is never silently left unverified.** When background checks are
   still running at the end of the next turn, that turn is folded into the next
   run instead of being skipped. Unverified code reaching the user with no trace
   at all is the silent form of the failure this guard exists to prevent.

## Failure recovery

| Situation | What sentinel does | What you (or the agent) should do |
|-----------|--------------------|-----------------------------------|
| A check fails | Prunes the trace to the valuable lines, adds the kind, the error summary, the blast radius and the bounded-retry budget. | Fix the cause; the message says whether the changes were restored. |
| `autoRollback` is on | Restores that mutation (or the whole turn) from the snapshot. | Re-apply the edit only after fixing the cause. |
| A conflicted file exists | Restores everything else, **leaves the conflicted file alone**, marks the rollback `partial`. | Review the file by hand; sentinel will not guess. |
| A step times out | Kills the tree, reports `timeout` and says the code is not the problem. | Re-run, or raise `timeoutMs`. Do not rewrite working code. |
| The command is missing | Reports `command-not-found` and says the pipeline or the tool is at fault. | Fix the configuration or install the tool. |
| The same error repeats | After `maxRepeatedFailures` identical failures it says so explicitly and tells the agent to change approach. | Re-evaluate the implementation, not the last edit. |
| The code state stops changing | The repair loop stops instead of re-prompting (`recovery.enabled`). | Read the report; another identical attempt would repeat itself. |
| The recovery budget is spent | With `rollbackAfterExhaustion` the state before the failing cycle is restored; otherwise the work stays and is reported. | Read what still fails; do not start another identical cycle. |
| A turn violates the change policy | The turn stops before verification, the violation is recorded, and with `rollbackOnViolation` its files are restored. | Revert the offending change, or relax `policy` in `sentinel.config.ts` if it was intended. |
| A file regressed from a verified state | Reported as a regression; with `revertOnRegression` that single file is restored. | Restore the file or justify the change — never silently keep both. |
| A check fails because the *environment* is broken | Classifies it (`timeout`, `command-not-found`, `environment-error`), leaves every file alone and spends no repair attempt. | Fix the tool, the network or the timeout. Do not touch the source. |
| A repair attempt edits files the cycle was not about | Names them under `REPAIR SCOPE EXCEEDED`, or refuses the write with `scopeGuard: "block"`. | Fix the cause inside the original scope, or stop and report. |
| The conversation is compacted | Restates the contract and the currently-green files, disowns summarized check results, carries the repair budget over. | Re-run any check whose result you only remember from the summary. |
| A write targets a protected path | Refuses the tool call before anything is written (`policy.blockBeforeWrite`). | Solve the task without that path, or relax the policy deliberately. |

## Configuration

Create `sentinel.config.ts` in the project root (or `~/.sentinel.config.ts`). Resolution order:
`<cwd>/sentinel.config.ts` → `<cwd>/sentinel.config.js` → `~/.sentinel.config.ts` → defaults.
Every event reloads the file (cache-busted by content hash, so an edit is picked
up without restarting pi and twice-in-one-tick edits cannot go unnoticed).

```ts
import { defineConfig } from "@patimweb/pi-sentinel";

export default defineConfig({
  // ── master switches ───────────────────────────────────────────────────
  enabled: true,
  autoRollback: true,          // restore on a failed check (destructive)

  // ── P0: close the loop ────────────────────────────────────────────────
  recovery: {
    enabled: true,             // re-prompt the agent with the failure
    maxAttempts: 3,            // …at most this many times
    rollbackAfterExhaustion: false, // restore the pre-cycle state when spent
  },
  // autoFix / maxAutoRetries are the legacy spellings, reconciled automatically.

  // ── P7: change policy (opt-in) ────────────────────────────────────────
  policy: {
    enabled: false,            // gate the *shape* of a turn, not just its result
    maxChangedFiles: 0,        // 0 = no limit
    maxAddedLines: 0,          // 0 = no limit
    allowPackageChanges: true,
    allowLockfileChanges: true,
    allowWorkflowChanges: true,
    sensitivePaths: [],        // project-relative globs that may never change
    rollbackOnViolation: false,
  },

  // ── P1: checkpoints ───────────────────────────────────────────────────
  checkpointRetention: 50,     // how many turn checkpoints stay on disk

  // ── P2: state-bound evidence ──────────────────────────────────────────
  trackVerifiedState: true,    // remember hashes of green states
  revertOnRegression: true,    // restore a file that regressed
  pruneStaleTraces: true,      // mark older sentinel traces superseded

  // ── P3: out-of-band changes ───────────────────────────────────────────
  detectOutOfBand: true,       // verify bash/formatter/git edits too

  // ── P4: revision contract ─────────────────────────────────────────────
  revisionContract: true,      // bounded-repair rules in the system prompt

  // ── P5: background & budget ───────────────────────────────────────────
  backgroundTurnEnd: true,     // do not block the turn on slow checks
  maxOutputTokens: 2500,       // model-visible output budget (0 = off)

  // ── P6: performance, cache & escalation ───────────────────────────────
  verification: {
    debounceMs: 150,           // 0 = verify every mutation immediately
    maxOutputBytes: 262144,    // per-step output buffer (head+tail kept)
    killGraceMs: 500,          // SIGTERM → SIGKILL grace period
    cache: {
      enabled: true,           // reuse a passing run for an identical state
      ttlMs: 300000,           // 0 = never expire
      maxEntries: 50,
      persist: true,           // survive a session restart
    },
    failureEscalation: {
      enabled: true,           // say so when the same error repeats
      maxRepeatedFailures: 3,
    },
  },

  // ── mindplace synergy ─────────────────────────────────────────────────
  impactAwareFocus: true,      // add graph dependents to the focus

  maxTraceLines: 12,

  pipelines: {
    // Keep per-mutation checks FAST — they run after every edit.
    onFileMutation: [
      {
        name: "type-check",
        cmd: "npm run typecheck",
        timeoutMs: 60000,
        priority: "critical",              // critical | normal | warning
        files: ["**/*.ts", "**/*.tsx"],    // only relevant file types
      },
      {
        name: "linter",
        cmd: "npx eslint --quiet",
        timeoutMs: 8000,
        priority: "warning",               // never fails a turn, never rolls back
        files: ["**/*.ts", "**/*.tsx"],
      },
    ],
    // Put the slow, whole-project checks here — they run once per turn.
    onTurnEnd: [
      {
        name: "unit-tests",
        cmd: "npm test",
        timeoutMs: 120000,
        priority: "critical",
        cacheable: false,       // a flaky suite must never be served from cache
      },
    ],
  },

  include: ["src/**/*.ts", "tests/**/*.ts"],   // [] = everything not excluded
  exclude: ["**/node_modules/**", "**/.git/**", "**/*.md", "dist/**"],
});
```

### Every key

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `enabled` | boolean | `true` | Master switch. When false the extension loads but does nothing. |
| `autoRollback` | boolean | `true` | Restore the mutated files when a critical step fails. |
| `recovery.enabled` | boolean | `true` | Re-prompt the agent with the pruned failure at turn end (P0). |
| `recovery.maxAttempts` | number | `3` | Upper bound on consecutive repair attempts (`>= 1`). |
| `recovery.rollbackAfterExhaustion` | boolean | `false` | Restore the pre-cycle state once the attempt budget is spent (P0). |
| `recovery.scopeGuard` | `"off" \| "report" \| "block"` | `"report"` | How a repair cycle that widens its file set is handled (P8). |
| `policy.enabled` | boolean | `false` | Gate the *shape* of a turn, not just its result (P7). |
| `policy.maxChangedFiles` | number | `0` | Max changed files per turn; `0` = no limit. |
| `policy.maxAddedLines` | number | `0` | Max added lines per turn; `0` = no limit. |
| `policy.allowPackageChanges` | boolean | `true` | Allow a `package.json` to be modified. |
| `policy.allowLockfileChanges` | boolean | `true` | Allow a lockfile to be modified. |
| `policy.allowWorkflowChanges` | boolean | `true` | Allow `.github/workflows/**` to be modified. |
| `policy.sensitivePaths` | string[] | `[]` | Project-relative globs that may never be modified. |
| `policy.blockBeforeWrite` | boolean | `true` | Refuse a write to a protected path instead of undoing it afterwards (P8). |
| `policy.rollbackOnViolation` | boolean | `false` | Restore the turn's files when the policy is violated. |
| `autoFix` | boolean | `true` | Legacy alias of `recovery.enabled`, kept in sync. |
| `maxAutoRetries` | number | `3` | Legacy alias of `recovery.maxAttempts`, kept in sync. |
| `checkpointRetention` | number | `50` | Turn checkpoints kept on disk; `0` keeps all. |
| `trackVerifiedState` | boolean | `true` | Hash and keep a copy of every state that passed (P2). |
| `revertOnRegression` | boolean | `true` | Restore a file that regressed away from its verified state. |
| `pruneStaleTraces` | boolean | `true` | Mark older sentinel traces superseded before each LLM call. |
| `detectOutOfBand` | boolean | `true` | Verify files changed outside `edit`/`write` (P3). |
| `revisionContract` | boolean | `true` | Inject the bounded-repair rules into the system prompt (P4). |
| `backgroundTurnEnd` | boolean | `true` | Run `onTurnEnd` without blocking the turn, re-wake on failure (P5). |
| `maxOutputTokens` | number | `2500` | Token budget for model-visible verification output; `0` = off. |
| `impactAwareFocus` | boolean | `true` | Extend the verification focus with code-graph dependents. |
| `maxTraceLines` | number | `12` | Critical error lines kept by the pruner. |
| `verification.debounceMs` | number | `0` | Coalesce mutations that land within this window (P6). |
| `verification.maxOutputBytes` | number | `262144` | Cap on one step's combined stdout+stderr before truncation. |
| `verification.killGraceMs` | number | `500` | Grace between `SIGTERM` and `SIGKILL` for a timed-out process tree. |
| `verification.cache.enabled` | boolean | `false` | Reuse a passing run for an identical code state (P6). |
| `verification.cache.ttlMs` | number | `300000` | Entry lifetime; `0` = never expire. |
| `verification.cache.maxEntries` | number | `50` | Entries kept before the oldest are evicted. |
| `verification.cache.persist` | boolean | `true` | Keep the cache on disk across sessions. |
| `verification.cache.steps` | string[] | — | Restrict caching to these step names. |
| `verification.failureEscalation.enabled` | boolean | `false` | Report a failure that keeps repeating (P6). |
| `verification.failureEscalation.maxRepeatedFailures` | number | `3` | Identical failures before escalation. |
| `pipelines.onFileMutation` | `PipelineStep[]` | type-check + warnOnly linter | Runs after every `edit`/`write`. |
| `pipelines.onTurnEnd` | `PipelineStep[]` | unit-tests | Runs once per turn. |
| `include` | string[] | `[]` | Globs that trigger verification; empty = all non-excluded files. |
| `exclude` | string[] | node_modules, .git, *.md, dist | Globs that never trigger verification. |

`PipelineStep`:
`{ name, cmd, timeoutMs, cwd?, env?, warnOnly?, priority?, phase?, files?, retry?, cacheable? }`.

- `priority`: `critical` | `normal` (default) | `warning`. `warning` never blocks a turn and never
  triggers a rollback; `warnOnly: true` is the older spelling of the same thing.
- `phase`: `mutation` | `turn` — restricts a step to one pipeline group (unset = both).
- `files`: globs the step applies to, e.g. `["**/*.ts"]`. Empty/absent = always relevant, so an
  unconfigured step behaves exactly as before.
- `retry`: `{ maxAttempts, retryOn: FailureKind[], delayMs? }` — retries **only** the infrastructure
  kinds you list (`timeout`, `environment-error`, ...). A real compile or test error is never retried.
- `cacheable`: set `false` for non-deterministic steps; it disables caching for that run.
- `cwd` is resolved inside the project root; a value that escapes it fails the step instead of running.

**Three gotchas worth knowing:**

1. **Arrays are replaced, not merged.** If you set `exclude`, the default entries are gone — re-list
   `**/node_modules/**` and friends yourself.
2. **`warnOnly: true` never triggers a rollback.** It only surfaces a warning, which is why the default
   linter step is safe in projects without eslint.
3. **`onFileMutation` runs after *every* edit.** Keep it incremental; full type-checks and test suites
   belong in `onTurnEnd`. A byte-identical rewrite is detected and skips the pipeline entirely.

## Hooks & trigger points

| Hook | Trigger | What it does |
|------|---------|--------------|
| `session_start` | session starts | Announce the armed state; reset the repair budget. |
| `before_agent_start` | user prompt submitted | Append the revision contract, including the files that are verified green right now (P4). |
| `message_start` | every message | Reset the repair budget **only for `role: "user"`** — sentinel's own continuations keep counting (P0). |
| `turn_start` | turn starts | Begin a fresh snapshot and checkpoint scope; fingerprint the already-dirty working tree as the out-of-band baseline (P3). |
| `tool_call` | before `edit` / `write` | Refuse the write when it targets a protected path or leaves the repair scope (P8); otherwise snapshot the target file and set the status indicator. |
| `tool_result` | after `edit` / `write` | Run `onFileMutation`, record evidence, optionally restore, inject `isError`. |
| `turn_end` | after a turn | Flush the checkpoint (P1), scan for out-of-band changes (P3), run `onTurnEnd` (sync or background, P5), re-prompt on failure (P0). |
| `session_compact` | after a compaction | Restate the contract and the currently-green files; disown summarized check results; carry the repair budget over (P8). |
| `context` | before each LLM call | Supersede older sentinel traces, and mark the newest one stale once the files it describes have changed (P2). |

## Synergy with pi-mindplace

`pi-mindplace` is the read phase — it builds a queryable AST graph so the agent knows *what and where*
to edit. `pi-sentinel` is the write phase — it guarantees the change actually compiles and tests green.
Together the graph supplies what sentinel is missing: **what depends on the thing that just broke.**

| Mindplace artifact | What sentinel does with it |
|---|---|
| `graph-out/graph.json` (`nodes[].sourceFile`, `edges[]`) | Impact analysis: names the dependents of the failing file in the failure payload. |
| `nodes[].label`, `nodes[].centrality` | Focus prioritisation — dependents' diagnostics are promoted by the pruner. |
| Symbol labels per file | Checkpoint labels: `undo: parseConfig, deepMerge (src/config.ts)`. |
| `graph.json` mtime vs. source mtimes | Honesty check — a stale or absent graph is reported instead of inventing an impact claim. |

```
Impact (code graph):
  • src/config.ts [parseConfig, deepMerge] → src/index.ts, src/tools/sentinel-status.ts
```

Implementation note: the adapter (`src/clients/mindplace.ts`) reads `graph-out/graph.json` directly
instead of importing `pi-mindplace`. That keeps sentinel free of a tree-sitter dependency, of the
graph's version churn, and of any hard failure when the graph extension is not installed. **Without a
graph every path degrades silently**, and the pipeline behaves exactly as before. Set
`impactAwareFocus: false` to turn the whole integration off.

## Development

Requires a Node build with native TypeScript support: the tests are `.ts` and run without a build
step, so an older runtime cannot even load them. `.node-version` pins 26, and CI tests 22.x + 26.x.

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # node --test — 177 tests, 44 suites
```

Test coverage by module:

| Test file | Covers |
|---|---|
| `tests/extension.test.ts` | **the real hook wiring end-to-end**: registration, P0 injection + all three stop conditions, P1 checkpoint flush/rewind, P2 evidence + regression + trace superseding, P3 out-of-band detection, P4 contract injection, P5 background + budget, rollback honesty, graph impact |
| `tests/config.test.ts` | defaults (every feature on), each feature switchable off, merge semantics, globs, include/exclude |
| `tests/pruner.test.ts` | trace pruning, feedback sections, section ordering, honest rollback wording |
| `tests/runner.test.ts` | subprocess execution, timeouts, exit codes, abort |
| `tests/snapshot.test.ts` | per-mutation and per-turn rollback, untracked files, byte-identical rewrites |
| `tests/checkpoints.test.ts` | flush/list/restore/prune/clear, restart survival, first-touch pre-state |
| `tests/evidence.test.ts` | verified-state ledger, regression detection, revert, state hashing |
| `tests/mindplace.test.ts` | impact, dependents, labels, staleness, silent degradation |
| `tests/workspace.test.ts` | porcelain parsing, real git repos, ignore predicate |
| `tests/spill.test.ts` | output budget, head/tail preview, spill-to-file fallback |
| `tests/feedback.test.ts` | composed failure payload, regression + impact sections, budget cap |
| `tests/contract.test.ts` | revision contract content and switches |
| `tests/smoke.test.ts` | imports, tool schemas, graceful non-repo behaviour |

The extension suite drives the real factory against a fake `ExtensionAPI`, so the paths that only
matter at runtime — "is the agent actually woken?", "does the checkpoint really restore?", "does the
turn block on the checks?" — are asserted rather than assumed.

## Design

Following the data-oriented pattern used across `@patimweb` packages:

- All domain data is represented as plain immutable interfaces (`src/types.ts`)
- I/O is isolated in client modules (`src/clients/`)
- Pure formatting functions convert data to display strings (`src/formatting/`)
- Each capability is a single-responsibility tool module (`src/tools/`)
- Config/state uses atomic, permission-safe file persistence (`src/config.ts`)
- Runtime state is scoped per project (`~/.pi/sentinel-state/<project>-<hash>/`)

```
src/clients/
  pipeline-runner.ts   subprocess execution, timeouts, aborts
  git-client.ts        working-tree rollback fallback
  snapshot.ts          in-memory pre-state capture & restore
  checkpoints.ts       durable turn checkpoints (P1)
  evidence.ts          verified-state ledger & regression detection (P2)
  workspace.ts         out-of-band change detection (P3)
  spill.ts             output budget & spill-to-file (P5)
  mindplace.ts         code-graph impact adapter
  rollback.ts          rollback strategy orchestration
src/formatting/
  pruner.ts            pure trace pruning & failure formatting
  feedback.ts          composed model-visible failure payload
src/prompt/
  contract.ts          revision contract (P4)
```

## License

MIT
