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
| Detects bash/formatter/git edits | sandbox-wide | documented blind spot | **`git status --porcelain` scan (P3)** |
| Stale verification traces | bounded retries, delta check | — | **superseded traces before every LLM call (P2)** |
| Verified-state memory | hook recipe | — | **content-hash ledger + regression revert (P2)** |
| Impact / blast radius | — | — | **code knowledge graph via pi-mindplace** |
| Bounded output | ~2,500 tokens + spill file | 10,000 chars + spill file | **`maxOutputTokens` + spill file (P5)** |
| Long checks off the critical path | background hooks | `asyncRewake` | **background turn-end + re-wake (P5)** |

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

## The six mechanisms

### P0 — close the loop: the agent is re-prompted, not just reported to

Claude Code's `Stop` hook and Codex's `Stop` hook both do the same thing on a failed check: they make
the agent **continue** with the failure as input. Sentinel now does too. When a turn ends red, the
pruned failure is sent as a message with `triggerTurn: true`, so the agent gets a new turn to fix it.

The loop is bounded, and the stop conditions follow Codex's own repair-loop guidance ("a good loop
stops for one of four reasons"):

| Stop condition | Implementation |
|---|---|
| checks pass | budget reset |
| retry budget exhausted | `maxAutoRetries` (default 3) |
| **the delta stops changing** | the code-state hash is identical to the one already re-prompted for |
| a real user prompt arrives | budget reset (only `role: "user"` messages reset it — sentinel's own continuations do not, otherwise the loop would be unbounded) |

```ts
autoFix: true,
maxAutoRetries: 3,
```

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

At every `turn_end` sentinel scans the working tree, subtracts the paths the hooks already captured,
and verifies the remainder too:

```ts
detectOutOfBand: true,
```

Caveat, stated honestly: those files are **verified but not snapshotted** — their pre-state was never
observed, so they cannot be restored from a checkpoint. Sentinel reports how many files that affects.

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
```

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

## Configuration

Create `sentinel.config.ts` in the project root (or `~/.sentinel.config.ts`). Resolution order:
`<cwd>/sentinel.config.ts` → `<cwd>/sentinel.config.js` → `~/.sentinel.config.ts` → defaults.
Every event reloads the file (mtime cache-busted), so editing it takes effect without restarting pi.

```ts
import { defineConfig } from "@patimweb/pi-sentinel";

export default defineConfig({
  // ── master switches ───────────────────────────────────────────────────
  enabled: true,
  autoRollback: true,          // restore on a failed check (destructive)

  // ── P0: close the loop ────────────────────────────────────────────────
  autoFix: true,               // re-prompt the agent with the failure
  maxAutoRetries: 3,           // …at most this many times

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

  // ── mindplace synergy ─────────────────────────────────────────────────
  impactAwareFocus: true,      // add graph dependents to the focus

  maxTraceLines: 12,

  pipelines: {
    // Keep per-mutation checks FAST — they run after every edit.
    onFileMutation: [
      { name: "type-check", cmd: "npm run typecheck", timeoutMs: 60000 },
      { name: "linter", cmd: "npx eslint --quiet", timeoutMs: 8000, warnOnly: true },
    ],
    // Put the slow, whole-project checks here — they run once per turn.
    onTurnEnd: [
      { name: "unit-tests", cmd: "npm test", timeoutMs: 120000 },
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
| `autoFix` | boolean | `true` | Re-prompt the agent with the pruned failure at turn end (P0). |
| `maxAutoRetries` | number | `3` | Upper bound on consecutive auto-fix continuations. |
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
| `pipelines.onFileMutation` | `PipelineStep[]` | type-check + warnOnly linter | Runs after every `edit`/`write`. |
| `pipelines.onTurnEnd` | `PipelineStep[]` | unit-tests | Runs once per turn. |
| `include` | string[] | `[]` | Globs that trigger verification; empty = all non-excluded files. |
| `exclude` | string[] | node_modules, .git, *.md, dist | Globs that never trigger verification. |

`PipelineStep`: `{ name, cmd, timeoutMs, cwd?, env?, warnOnly? }`.

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
| `before_agent_start` | user prompt submitted | Append the revision contract (P4). |
| `message_start` | every message | Reset the repair budget **only for `role: "user"`** — sentinel's own continuations keep counting (P0). |
| `turn_start` | turn starts | Begin a fresh snapshot scope and checkpoint scope. |
| `tool_call` | before `edit` / `write` | Snapshot the target file; set the status indicator. |
| `tool_result` | after `edit` / `write` | Run `onFileMutation`, record evidence, optionally restore, inject `isError`. |
| `turn_end` | after a turn | Flush the checkpoint (P1), scan for out-of-band changes (P3), run `onTurnEnd` (sync or background, P5), re-prompt on failure (P0). |
| `context` | before each LLM call | Keep only the newest sentinel trace live (P2). |

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
npm test              # node --test — 175 tests, 43 suites
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
