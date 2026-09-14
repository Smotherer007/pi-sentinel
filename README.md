# pi-sentinel

![A knight with a checked shield blocking red error windows on a bridge, while verified files continue past a checkpoint tower towards a green check](https://raw.githubusercontent.com/Smotherer007/pi-sentinel/main/banner.png)

In-loop verification, repair and rollback hardening for the
[pi coding agent](https://github.com/earendil-works/pi).

Sentinel sits between the agent and your working tree. It runs your checks when files change, turns
a failure into a signal the agent can act on instead of a wall of output, remembers which code
actually passed, refuses the changes it could never undo, and puts back what it captured when
something breaks. The goal is not to make the agent smarter — it is to make sure that what the agent
believes about your code is true, and that a bad turn costs you nothing.

**Everything is on by default.** A fresh project gets the mechanisms Codex CLI and Claude Code rely
on without writing a config file first:

| | Codex CLI | Claude Code | pi-sentinel |
|---|---|---|---|
| Failure fed back into the loop | `PostToolUse` → `decision: "block"` replaces the tool result | `PostToolUse` → `additionalContext` | `tool_result` prepends the pruned trace and sets `isError` |
| **Turn end re-prompts the agent** | `Stop` → continuation prompt | `Stop` → conversation continues | **`turn_end` → `pi.sendMessage(…, { triggerTurn: true })`**, bounded |
| Loop guard | `continue: false` | `stop_hook_active` | **attempt budget + "the code state did not move" + scope narrowing** |
| Code checkpoints | git checkpoints (manual) | checkpointing + `/rewind` | **durable turn checkpoints + `/sentinel rewind`** |
| Rollback precision | git stash | skips bash edits, subagents, symlinks | **file snapshots incl. newly created files; unrelated work untouched** |
| Detects bash/formatter/git edits | sandbox-wide | documented blind spot | **`git status --porcelain` against a per-turn baseline** |
| Refuses a bad write before it happens | approval modes | `PreToolUse` → `deny` | **`tool_call` → `block` for protected paths and repair scope** |
| Shell commands are governed | OS sandbox (seatbelt/landlock) | permission rules per command | **classified; refused when unrecoverable, snapshotted when destructive** |
| **A `bash` deletion can be undone** | sandbox-wide snapshot | not covered | **pre-state captured before the command runs** |
| Stale verification traces | bounded retries, delta check | — | **superseded, and marked stale once their files change** |
| Verified-state memory | hook recipe | — | **content-hash ledger + regression revert** |
| Environment failure ≠ code failure | sandbox reports it | — | **timeout / missing tool / env error never rolls back** |
| Survives context compaction | — | `PreCompact` hook | **`session_compact` restates the invariants; budget carries over** |
| Impact / blast radius | — | — | **code knowledge graph via pi-mindplace** |
| Bounded output | ~2,500 tokens + spill file | 10,000 chars + spill file | **`maxOutputTokens` + spill file** |
| Long checks off the critical path | background hooks | `asyncRewake` | **background turn-end + re-wake** |

It is **not** a sandbox, and the section [The boundary](#the-boundary) says exactly where that line
runs.

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [What sentinel guarantees](#what-sentinel-guarantees)
- [The ten mechanisms](#the-ten-mechanisms)
- [Rollback model](#rollback-model)
- [Tools](#tools)
- [Commands](#commands)
- [Configuration](#configuration)
- [Failure recovery](#failure-recovery)
- [Performance](#performance)
- [Hooks & trigger points](#hooks--trigger-points)
- [Synergy with pi-mindplace](#synergy-with-pi-mindplace)
- [What sentinel writes to disk](#what-sentinel-writes-to-disk)
- [Development](#development)
- [Design](#design)

## Requirements

Node **22.18 or newer**. The package ships TypeScript sources and relies on Node's native type
stripping, so an older runtime fails at import with an unexplained syntax error. This is declared as
`engines.node`, so `npm install` warns you rather than letting you find out at run time.

`git` is optional. Without a repository, out-of-band detection and the `mode: "head"` reset are
unavailable; everything else works unchanged.

## Installation

```bash
# From npm
pi package add npm:@patimweb/pi-sentinel

# From a local checkout during development
pi --extension ./index.ts
```

Sentinel registers itself as a pi extension. On the next session start it announces what it is armed
with:

```
Sentinel armed (auto-fix, auto-rollback, evidence, out-of-band, shell guard (block), cache)
```

## Quick start

Sentinel works with no configuration: it type-checks after every edit and runs `npm test` at the end
of each turn. To point it at your project's own commands, create `sentinel.config.ts` in the project
root:

```ts
import { defineConfig } from "@patimweb/pi-sentinel";

export default defineConfig({
  pipelines: {
    // Fast — runs after every edit/write.
    onFileMutation: [
      { name: "type-check", cmd: "npm run typecheck", timeoutMs: 60000, files: ["**/*.ts"] },
    ],
    // Slow — runs once per turn, in the background.
    onTurnEnd: [
      { name: "unit-tests", cmd: "npm test", timeoutMs: 120000, cacheable: false },
    ],
  },
});
```

That is the whole minimum. Every other key has a default that is meant to be the right answer; the
[configuration reference](#every-key) lists them all.

Two commands to know: `/sentinel status` shows what is armed and what has happened, and
`/sentinel rewind` takes a turn back.

## How it works

Sentinel attaches to four moments in the agent loop: before a tool runs, after it runs, at the end
of a turn, and before every call to the model.

```
 ┌─ before a tool runs ─────────────────────────────────────────────────────┐
 │  tool_call                                                               │
 │    edit / write ──→ protected path?  outside the repair scope?  ──→ BLOCK│
 │                 └─→ otherwise: snapshot the file's pre-state             │
 │    bash ──────────→ unrecoverable? (curl|sh, force-push, publish) ──→BLOCK│
 │                 └─→ destructive? capture what it would destroy, then run │
 └──────────────────────────────────────────────────────────────────────────┘
                                    │
 ┌─ after a tool runs ──────────────▼───────────────────────────────────────┐
 │  tool_result                                                             │
 │    run the onFileMutation pipeline on what changed                       │
 │    green → record the verified state    red → prepend the pruned trace   │
 └──────────────────────────────────────────────────────────────────────────┘
                                    │
 ┌─ end of the turn ────────────────▼───────────────────────────────────────┐
 │  turn_end                                                                │
 │    1. scan the working tree for changes no hook saw (against a baseline) │
 │    2. evaluate the change policy — the wrong shape is stopped here       │
 │    3. flush a durable checkpoint of the turn's pre-state                 │
 │    4. run the onTurnEnd pipeline (in the background by default)          │
 │    5. red? decide: re-prompt, stop, or give up — always bounded          │
 └──────────────────────────────────────────────────────────────────────────┘
                                    │
 ┌─ before every model call ────────▼───────────────────────────────────────┐
 │  context                                                                 │
 │    older sentinel traces  → superseded                                   │
 │    the live trace, if its files changed → marked STALE                   │
 └──────────────────────────────────────────────────────────────────────────┘
```

On a red check, the payload the model receives is composed rather than dumped:

```
[sentinel] Verification failed at step "type-check"
exit code: 2 | duration: 1840ms | kind: type error
what failed: src/config.ts(84,3): error TS2322: Type 'string' is not assignable to type 'number'
state: 9f2c41a7be03
────────────────────────────────────────────────────────────
src/config.ts(84,3): error TS2322: Type 'string' is not assignable to type 'number'
src/config.ts(91,7): error TS2554: Expected 2 arguments, but got 1
────────────────────────────────────────────────────────────
Regressed from a verified state (1 file(s)):
  • src/config.ts — was green at 2026-09-14 08:12:03 (onTurnEnd:unit-tests)
Impact (code graph built 2026-09-14 07:14:22):
  • src/config.ts [parseConfig, deepMerge] → src/index.ts, src/tools/sentinel-status.ts
Your changes are still in place. Fix the reported error; do not repeat the same edit.
Repair attempt 1/3. After 3, stop and report what still fails instead of editing again.
```

Every line in that block is there to remove a specific way the loop goes wrong: the `kind` stops the
agent rewriting code because a check timed out, the `state` hash lets a later run tell whether this
result is still current, the regression line says "this used to work", the impact section says what
else to look at, and the attempt counter says when to stop.

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
    scopeGuard: "block",           // and never let it widen while it runs
  },
  policy: {
    enabled: true,                 // refuse the wrong *shape* of change, too
    maxChangedFiles: 15,
    maxAddedLines: 600,
    allowWorkflowChanges: false,
    sensitivePaths: [".env", "secrets/**"],
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
              … the agent tries to edit an unrelated file?
              → refused: this cycle is about src/foo.ts
              … still red after 3 attempts?
              → restore the files changed since the first attempt
              → report to the human: "recovery exhausted"
```

What that buys you: unrelated uncommitted work is never touched, a repair loop cannot run forever or
spread, a spent budget cannot leave a half-finished edit behind, and a change that would rewrite CI
or a lockfile is stopped before it is ever verified.

## What sentinel guarantees

These are not configurable, and they are the reason the rest is trustworthy.

1. **Nothing unrelated is ever overwritten.** Restores are file-based, from a snapshot taken before
   the mutation. `git checkout -- .` is never used while a snapshot exists, and untracked files the
   agent did not create are never touched.
2. **A file that changed after the agent's mutation is not restored.** Sentinel records a hash of
   what the agent's write left on disk. If the file no longer matches, somebody else wrote it — a
   formatter, another process, you — and the rollback reports a conflict instead of overwriting:

   ```
   ROLLBACK CONFLICT (1 file(s)) — NOT overwritten:
     src/foo.ts was modified after the Sentinel snapshot.
       expected: 3f9a1c2b7d4e | current: 91b4d0aa77c1
     The file was NOT overwritten. Manual recovery required.
   ```

3. **A partial restore is never reported as a restore.** Files that could not be put back are named,
   and their state is described as unknown rather than guessed at.
4. **Secrets never reach the model.** Step output passes through `redactSecrets` — values of
   credential-looking environment variables plus well-known key shapes — before it leaves the runner,
   and `/sentinel config` redacts configured `env` values.
5. **A timeout kills the process tree.** Steps run in their own process group; `SIGTERM` is followed
   by `SIGKILL` after `killGraceMs`, so nothing keeps burning CPU after sentinel reported the timeout.
6. **Output and runtime are bounded.** `maxOutputBytes` per step, `timeoutMs` per step,
   `maxOutputTokens` for the model-visible payload, with the remainder spilled to a file.
7. **A step's `cwd` cannot leave the project root.** A step that tries fails with an environment
   error rather than running elsewhere.
8. **An environment failure never costs you code.** A timeout, a missing binary or an `EACCES` says
   nothing about what you wrote. Those kinds never trigger a rollback, never revert a regression and
   never spend a repair attempt.
9. **A destructive shell command is captured before it runs, or refused.** `bash` gets the same
   treatment as a write.
10. **A turn is never silently left unverified.** If background checks are still running when the
    next turn ends, that turn is folded into the next run rather than skipped.

## The ten mechanisms

The `P0`–`P9` labels are used throughout the source comments, so they are kept here as anchors. Each
one exists because of a specific way an agent loop goes wrong:

| | Mechanism | The failure it prevents |
|---|---|---|
| **P0** | [Close the loop](#p0--close-the-loop) | A failure that only reaches the human, and a repair loop with no end. |
| **P1** | [Durable checkpoints](#p1--durable-checkpoints-and-sentinel-rewind) | "The last turn broke something" with nothing left to undo it. |
| **P2** | [State-bound evidence](#p2--state-bound-evidence) | Acting on a check result that describes code which no longer exists. |
| **P3** | [Out-of-band changes](#p3--changes-no-hook-saw) | `sed -i`, formatters and generators changing files invisibly. |
| **P4** | [Revision contract](#p4--a-revision-contract-in-the-system-prompt) | Rewriting code that already passed; claiming a check that never ran. |
| **P5** | [Background checks & output budget](#p5--background-checks-and-an-output-budget) | A slow suite blocking every turn; compiler noise eating the context. |
| **P6** | [Coalescing, classification, cache](#p6--coalescing-classification-cache-and-escalation) | Four checks for four edits; rewriting code because `npx` was slow. |
| **P7** | [Change policy](#p7--green-code-can-still-be-the-wrong-change) | A green diff that touches twenty files, CI and a lockfile. |
| **P8** | [Defending the context](#p8--the-context-is-the-product-so-it-is-defended) | Bad writes that must be undone; a repair cycle that spreads; compaction. |
| **P9** | [Shell governance](#p9--the-shell-is-governed-too) | `rm -rf src` with nothing to roll back. |

### P0 — close the loop

A failing check that only reaches the human is not a guard, it is a notification. When a turn ends
red, sentinel re-prompts the agent with the pruned failure instead:

```ts
pi.sendMessage({ customType: "sentinel-verify", content: payload }, { triggerTurn: true });
```

What makes this safe is where it stops. Three conditions end a cycle, and all three are pure
functions of the state (`src/clients/repair.ts`, tested as a truth table):

- **The attempt budget is spent.** `recovery.maxAttempts`, default 3. Optionally
  (`rollbackAfterExhaustion`) the tree returns to the state before the *first* failed attempt, not
  merely the last.
- **The code state did not move.** The hash of the files in scope is identical to the one already
  re-prompted for, so another attempt would repeat itself verbatim.
- **The failure is not about the code.** A timeout, a missing binary or an environment error never
  spends an attempt (see P6).

Only a real user message resets the budget. Sentinel's own continuations arrive as `custom` messages
and keep counting, which is the difference between a bounded loop and an unbounded one — and a
compaction does not reset it either (P8).

Every decision is written to `autoFixHistory`, including the ones where the guard gave up.

### P1 — durable checkpoints and `/sentinel rewind`

The in-memory snapshot scope is dropped when a turn ends, which leaves the most common recovery case
unsolved: *the last turn broke something, take it back*. At every `turn_end` the turn's pre-state is
flushed to disk — real file bytes plus a manifest — so it can be restored from a later turn, or
after restarting the session entirely.

```
<projectDir>/checkpoints/<seq>-<id>/manifest.json
<projectDir>/checkpoints/<seq>-<id>/blobs/<n>.blob
```

`/sentinel rewind` offers code, conversation, both, or a summary from that point; the
`sentinel_rewind` tool exposes the code half to the agent. A restore refuses to overwrite a file that
changed after the checkpointed turn, and labels each checkpoint with symbol names from the code graph
when one exists, so the list reads like a changelog:

```
3-a1b2c3d4  2026-09-14 08:12:03  turn 7  4 file(s)  parseConfig, deepMerge (src/config.ts) +3 file(s)
```

`checkpointRetention` (default 50) bounds what stays on disk.

### P2 — state-bound evidence

The measurable failure mode of repair loops is not too few retries. It is revising code that already
passed, with *stale verification traces* as the mechanism. The countermeasure is to bind every claim
to the exact code state that produced it.

Sentinel keeps a per-file ledger of the content hash that last passed, plus a restorable copy:

```
<projectDir>/verified.json
<projectDir>/verified-blobs/<hash>.blob
```

Three things follow from it:

1. **Regressions are named.** A file that was green at hash *X*, differs now, and is implicated in a
   failure is reported as *that* — "this used to work" — instead of repeating the raw error.
2. **A regressed file can be put back** on its own (`revertOnRegression`), without touching the rest
   of the turn. Two guards keep this from destroying work: the file must be one the agent itself
   wrote this turn, and it must still be exactly what the agent left.
3. **Green evidence reaches the agent.** The contract (P4) lists the files that are verified *at
   their current content*, so "do not rewrite code whose checks passed" is a fact rather than an
   appeal.

Trace hygiene is the other half. Before every model call, older sentinel traces are replaced by a
one-line notice, and the live trace is marked `STALE` once the files it describes have changed — its
diagnostics are kept, because some may still be unfixed, but it stops counting as the current state.

### P3 — changes no hook saw

Sentinel observes `edit` and `write`. A large share of real edits does not travel through them:
`sed -i`, a formatter, `git apply`, a code generator, `npm run fix`. At `turn_start` sentinel
fingerprints everything the working tree already reports as dirty; at `turn_end` it scans again and
verifies the difference.

Both halves matter more than they look:

- **The working tree is not a diff.** `git status` lists every uncommitted change, not the ones this
  turn made. Without the baseline, your work in flight is attributed to the agent — and because the
  focus set feeds the state hash that bounds the repair loop (P0), that hash would drift with files
  nobody in this turn touched.
- **Porcelain paths are repository-root-relative**, never relative to the current directory. Running
  the agent in a package inside a monorepo is ordinary, and resolving those paths against the cwd
  produces paths that do not exist. Everything goes through `git rev-parse --show-toplevel`, mapped
  back through the caller's own (possibly symlinked) prefix.

Since P9, files touched by a *guarded* shell command are snapshotted too, so the old caveat — "seen
but not restorable" — now applies only to commands sentinel was configured not to guard.

### P4 — a revision contract in the system prompt

Rules in a prompt are cheaper than guard rails in code. Once per user turn sentinel appends a short,
configuration-aware block:

```
[sentinel:revision-contract] active in this repository:
- A green check is evidence. Do not rewrite code whose checks just passed unless the user asked for
  exactly that change.
- At most 3 repair attempts per failing check. If the last attempt fails again, stop and report.
- Never state that a check passes unless you ran it in this turn.
- Verified green right now, at their current content: src/config.ts, src/types.ts (+4 more).
- autoRollback is on: a failing check restores the files you changed.
```

It is re-stated per turn rather than accumulated, so the rules are always scoped to the work that was
actually asked for. `revisionContract: false` turns it off.

### P5 — background checks and an output budget

A full test suite on the critical path makes every turn feel slow. With `backgroundTurnEnd` (default
on) the turn ends immediately and the checks run behind it; a failure re-wakes the agent.

Two rules keep that honest. A background run fingerprints the state it is about, and if the code
moved while it ran, the stale result is reported to the human and never re-prompted or acted on. And
a turn that arrives while a run is in flight is **folded into the next run**, never skipped — letting
unverified code through with no trace at all is the silent form of the failure this guard exists to
prevent.

Model-visible output is capped at `maxOutputTokens` (default 2500). Anything larger becomes a
head/tail preview plus a path:

```
… [sentinel: output truncated to 2500 tokens — full output: <projectDir>/spills/2026-09-14T08-12-03-unit-tests.log]
```

### P6 — coalescing, classification, cache and escalation

Four `edit` calls in one assistant message produce four `tool_result` hooks milliseconds apart.
`verification.debounceMs` merges them into one run whose scope is the union.

**Classification** is the part that changes behaviour most. A failed step is categorised — `type-error`,
`lint-error`, `test-failure`, `build-failure`, `timeout`, `command-not-found`, `environment-error`,
`unknown` — and the category decides what happens:

| Kind | Rollback | Repair attempt | What the agent is told |
|---|---|---|---|
| `type-error`, `test-failure`, `build-failure`, `lint-error` | yes | yes | Fix the reported error. |
| `timeout`, `command-not-found`, `environment-error` | **never** | **never** | The environment failed, not your code. Do not rewrite it. |

That asymmetry matters: a slow `npx` used to be indistinguishable from a compile error, and with
`autoRollback` on it cost you the edit.

**The cache** (`verification.cache`, opt-in) skips a run whose answer cannot have changed. The key
covers the content of every changed file, the lock/tsconfig files, the effective step configuration,
the Node version and the environment variables that alter results. Only *passing* runs are cached —
a cached failure would freeze a transient problem into a permanent one — and `cacheable: false` opts
a non-deterministic step out.

**Escalation** (opt-in) counts identical failure signatures. When the state keeps changing but the
error does not, the approach is wrong rather than the last edit, and the payload says so.

### P7 — green code can still be the wrong change

Verification answers "does it work?". A change policy answers a different question: "is this the kind
of change that was supposed to happen?" Twenty unrelated files, a 500-line diff or a rewritten CI
workflow can all be green and still be a serious mistake.

```ts
policy: {
  enabled: true,
  maxChangedFiles: 15,
  maxAddedLines: 600,
  allowWorkflowChanges: false,
  allowLockfileChanges: false,
  sensitivePaths: [".env", "secrets/**", "infra/**"],
}
```

With `blockBeforeWrite` (default on once the policy is enabled) a write to a protected path is
refused in `tool_call` — nothing is written, so there is nothing to undo. The turn-end evaluation
still runs, because it is the only thing that can see a change made through bash. Line statistics use
a bounded LCS diff, so a huge generated file cannot turn the check into a CPU sink, and `0` means "no
limit" rather than "zero allowed".

### P8 — the context is the product, so it is defended

P0, P2 and P4 all rest on one assumption: that what the agent reads about the code is bound to the
code as it is. Three things break that assumption.

**A write that should never happen is refused, not undone.** `tool_call` returns
`{ block: true, reason }` — pi's equivalent of Claude Code's `PreToolUse` deny — for a path the
policy protects and for an edit that reaches outside the current repair cycle.

**A repair cycle may not widen.** The first failing turn fixes the file set the cycle is about. A
later attempt that edits something else is not repairing a cause, it is varying an approach.
`recovery.scopeGuard: "report"` (default) names the offending files in the payload; `"block"` refuses
the edit. A new user message opens a fresh cycle, because asking for something else is not a widening
repair.

**A compaction does not launder stale evidence.** Compaction replaces the conversation with a
summary, and a summarised "the tests passed" is exactly the unbound evidence that sends a loop after
code that has already moved. On `session_compact` sentinel restates the invariants, re-lists the
files that are green at their current content, and explicitly disowns any check result recalled from
the summary. The repair budget carries across — a loop that could buy fresh attempts by triggering a
compaction would not be bounded at all.

### P9 — the shell is governed too

Everything above is keyed to `edit` and `write`. `bash` was not, and that was the largest hole in the
guarantee: an `rm -rf src`, a `git reset --hard`, a `sed -i` across the repo were invisible to the
snapshot store, so there was nothing to roll back afterwards.

Every command now goes through the same gate, and lands in one of three places:

**Refused.** Nothing sentinel could do would make it undoable: network content piped into an
interpreter (`curl … | sh`), a forced push, `npm publish`, `gh release create`, `sudo`. The agent
gets a reason it can act on, and nothing ran.

**Protected, then allowed.** The command removes or overwrites files sentinel guards. Their pre-state
is captured *before* the command runs, so `sentinel_rollback` and `/sentinel rewind` undo a shell
deletion exactly as they undo an edit — including restoring files the command removed entirely.

**Noted.** An ordinary `git push`, a `docker system prune`: the human is told, the command runs.
Refusing these by default would make the guard the problem.

The protected scope is the same one sentinel verifies. A path the config excludes is not sentinel's
to protect, so `rm -rf node_modules` costs nothing and is allowed, while `rm -rf src` is captured
first. What it guards, it guards; what it ignores, it ignores.

When the blast radius cannot be determined — a glob only the shell can expand, more files than
`maxProtectedFiles`, a command that names no path at all — the command is refused in `block` mode
rather than run with a partial safety net. Breaking the guarantee loudly is better than breaking it
silently.

#### The boundary

**This is a guard against the agent's mistakes, not a security boundary.** Shell is a programming
language: `$(echo cm0K | base64 -d) -rf .` defeats any classifier, and pi's own documentation is
explicit that "a partial in-process sandbox would be easy to misunderstand as a security boundary".
Sentinel does not contradict that. It catches the destructive command an agent writes when it is
confused — the case that actually happens — and says so rather than implying more. Commands whose
intent cannot be read are refused *because* they cannot be read, not because they were judged
malicious.

Real isolation has to come from the operating system. Run pi in a container, or route its tools into
[Gondolin](https://github.com/earendil-works/gondolin). P9 is what you want *in addition* to that,
not instead of it.

## Rollback model

Sentinel snapshots the pre-state of every file the agent touches *before* the mutation runs, and
keeps it in a per-turn journal. On a critical failure it restores exactly those files, in this order
of preference:

1. **Mutation failure** (`onFileMutation`) → only the offending mutation's files.
2. **Turn failure** (`onTurnEnd`) → every file touched during the turn, including files the agent
   **newly created**, and files a guarded shell command removed.
3. **Regressed verified file** (P2) → that single file, from `verified-blobs/`.
4. **Checkpoint restore** (P1) → any earlier turn, by id, from `checkpoints/`.
5. **`git checkout -- .`** → only for an explicit `mode: "head"`, never as an automatic fallback.

Limits, stated plainly:

- Files larger than **4 MB** are not snapshotted; a restore touching one is reported as *partial*.
- **Symlinks are never restored.** A link is a distinct object, not a copy of its target; writing the
  target's bytes back at the link path would replace the link and leave the real target changed.
- A shell command sentinel was configured **not** to guard (`bash.mode: "off"`, or an `allow`
  prefix) has no captured pre-state, so its changes are verified but not restorable. Use git.
- **`autoRollback: true` is the default.** A failing check restores the files the agent changed. If
  you would rather keep broken work in place and repair it by hand, set it to `false` — the feedback
  loop still runs, and this repository's own config does exactly that.

## Tools

The agent can call these directly.

| Tool | Parameters | What it does |
|---|---|---|
| `sentinel_verify` | `trigger`: `"mutation"` \| `"turn"`, `rollback`: boolean | Runs a pipeline group on demand, bypassing both the cache and the debounce window. Reports the same enriched payload the hooks produce. |
| `sentinel_rollback` | `mode`: `"turn"` \| `"head"`, `force`: boolean | Restores the files changed this turn (safe, default), or hard-resets tracked files to HEAD (destructive, gated behind `force` while `autoRollback` is off). |
| `sentinel_rewind` | `mode`: `"list"` \| `"code"`, `checkpointId` | Lists durable checkpoints, or restores the working tree to one. Never touches files that turn did not change. |
| `sentinel_status` | — | Configuration, git state, checkpoints, verified-state count, graph freshness, metrics and recent history. |
| `sentinel_doctor` | — | Is sentinel working *here*: hooks, session ctx, storage, git, node, pipeline commands on PATH, graph age, rollback readiness and the open repair cycle. Use it when a sentinel message looks wrong, or before trusting sentinel after a reload. |

## Commands

| Command | What it does |
|---|---|
| `/sentinel` | Show the command list. |
| `/sentinel status` | Armed state, pipelines, git, latest checkpoint, metrics, turn history. |
| `/sentinel doctor` | Classified health report: what is broken now, what is imperfect, what a bad turn would cost. Renders the same report as the `sentinel_doctor` tool. |
| `/sentinel verify` | Run the `onFileMutation` pipelines now. |
| `/sentinel test` | Run the `onTurnEnd` pipelines now. |
| `/sentinel rollback` | Restore this turn's changes, or reset to HEAD when no snapshot exists. |
| `/sentinel rewind` | Interactive menu: code, conversation, both, or summarise from a checkpoint. |
| `/sentinel config` | Dump the active configuration, with `env` values redacted. |

## Configuration

Create `sentinel.config.ts` in the project root, or `~/.sentinel.config.ts` for a global default.
Resolution order: `<cwd>/sentinel.config.ts` → `<cwd>/sentinel.config.js` → `~/.sentinel.config.ts` →
built-in defaults. The file is re-read when its content changes, so an edit takes effect without
restarting pi.

Dangerous values are reported by name at load time rather than silently repaired — an invalid
`timeoutMs`, an unusable `maxOutputBytes`, a `maxTraceLines` that would keep no error lines.

### Pipeline steps

```ts
{
  name: "type-check",              // shown in every message
  cmd: "npm run typecheck",        // run through the platform shell
  timeoutMs: 60000,                // required; must be positive and finite
  cwd: "packages/core",            // optional; may not escape the project root
  env: { CI: "1" },                // merged into the child process
  files: ["**/*.ts", "**/*.tsx"],  // skip the step when nothing matching changed
  phase: "mutation",               // "mutation" | "turn"; unset means both
  priority: "critical",            // "critical" | "normal" | "warning"
  cacheable: false,                // never reuse a passing result for this step
  maxTraceLines: 30,               // per-step override of the pruner budget
  retry: {                         // infrastructure failures only
    maxAttempts: 2,
    retryOn: ["timeout", "environment-error"],
    delayMs: 1000,
  },
}
```

`warnOnly: true` is the older spelling of `priority: "warning"` and still works. A `warning` step
never blocks a turn and never triggers a rollback.

### Every key

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `enabled` | boolean | `true` | Master switch. When false the extension loads but does nothing. |
| `autoRollback` | boolean | `true` | Restore the mutated files when a critical step fails. |
| `recovery.enabled` | boolean | `true` | Re-prompt the agent with the pruned failure at turn end (P0). |
| `recovery.maxAttempts` | number | `3` | Upper bound on consecutive repair attempts (`>= 1`). |
| `recovery.rollbackAfterExhaustion` | boolean | `false` | Restore the pre-cycle state once the budget is spent. |
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
| `bash.enabled` | boolean | `true` | Inspect `bash` commands at all (P9). |
| `bash.mode` | `"off" \| "report" \| "block"` | `"block"` | Refuse unsafe commands, only name them, or do neither. |
| `bash.snapshotBeforeDestructive` | boolean | `true` | Capture the pre-state of files a destructive command would touch. |
| `bash.maxProtectedFiles` | number | `500` | Cap on files captured for one command; beyond it the command is not undoable. |
| `bash.allow` | string[] | `[]` | Command prefixes that are always permitted. |
| `autoFix` | boolean | `true` | Legacy alias of `recovery.enabled`, kept in sync. |
| `maxAutoRetries` | number | `3` | Legacy alias of `recovery.maxAttempts`, kept in sync. |
| `checkpointRetention` | number | `50` | Turn checkpoints kept on disk; `0` keeps all. |
| `trackVerifiedState` | boolean | `true` | Hash and keep a copy of every state that passed (P2). |
| `revertOnRegression` | boolean | `true` | Restore a file that regressed away from its verified state. |
| `pruneStaleTraces` | boolean | `true` | Supersede older traces and mark the live one stale when its files change. |
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

## Failure recovery

| Situation | What sentinel does | What you (or the agent) should do |
|-----------|--------------------|-----------------------------------|
| A check fails | Prunes the trace to the valuable lines, adds the kind, the summary, the blast radius and the retry budget. | Fix the cause; the message says whether the changes were restored. |
| `autoRollback` is on | Restores that mutation (or the whole turn) from the snapshot. | Re-apply the edit only after fixing the cause. |
| A conflicted file exists | Restores everything else, **leaves the conflicted file alone**, marks the rollback `partial`. | Review the file by hand; sentinel will not guess. |
| A check fails because the *environment* is broken | Classifies it, leaves every file alone, spends no repair attempt. | Fix the tool, the network or the timeout. Do not touch the source. |
| The same error repeats | After `maxRepeatedFailures` identical failures it says so and tells the agent to change approach. | Re-evaluate the implementation, not the last edit. |
| The code state stops changing | The repair loop stops instead of re-prompting. | Read the report; another identical attempt would repeat itself. |
| The recovery budget is spent | With `rollbackAfterExhaustion` the pre-cycle state is restored; otherwise the work stays and is reported. | Read what still fails; do not start another identical cycle. |
| A repair attempt edits files the cycle was not about | Names them under `REPAIR SCOPE EXCEEDED`, or refuses the write with `scopeGuard: "block"`. | Fix the cause inside the original scope, or stop and report. |
| A turn violates the change policy | Stops the turn before verification, records it, and with `rollbackOnViolation` restores its files. | Revert the change, or relax `policy` if it was intended. |
| A write targets a protected path | Refuses the tool call before anything is written. | Solve the task without that path, or relax the policy deliberately. |
| A shell command would destroy files | Captures their pre-state first, then lets it run; `sentinel_rollback` can undo it. | Nothing — this is the case that used to be unrecoverable. |
| A shell command's blast radius is unknowable | Refuses it and says why (a glob, too many files, no named path). | Name the exact paths, or run it yourself. |
| A shell command cannot be undone at all | Refuses it (`curl \| sh`, forced push, publish, `sudo`). | Do it another way, or run it yourself outside the agent. |
| A file regressed from a verified state | Reports it; with `revertOnRegression` that single file is restored. | Restore the file or justify the change — never silently keep both. |
| The conversation is compacted | Restates the contract and the green files, disowns summarised results, carries the budget over. | Re-run any check whose result you only remember from the summary. |
| The code graph predates the session | Says so once and names `mindplace_build`; payloads label how old the blast radius is. | Rebuild the graph, or accept degraded impact analysis knowingly. |

## Performance

The rule is simple: **mutation checks must be fast, expensive checks belong in `onTurnEnd`.**

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

`/sentinel status` reports the counters: checks, cache hits/misses, average duration, timeouts,
skipped/retried steps, escalations, rollbacks, refused writes and commands, and files protected
before a shell command.

## Hooks & trigger points

| Hook | Trigger | What it does |
|------|---------|--------------|
| `session_start` | session starts | Announce the armed state; reset the repair budget and the graph-freshness notice. |
| `before_agent_start` | user prompt submitted | Append the revision contract, including the files verified green right now (P4). |
| `message_start` | every message | Reset the repair budget **only for `role: "user"`** — sentinel's own continuations keep counting (P0). |
| `turn_start` | turn starts | Begin a snapshot and checkpoint scope; fingerprint the already-dirty working tree as the out-of-band baseline (P3). |
| `tool_call` | before `edit` / `write` | Refuse a write to a protected path or outside the repair scope (P8); otherwise snapshot the target file. |
| `tool_call` | before `bash` | Classify the command; refuse what cannot be undone, capture the pre-state of what it would destroy, note the rest (P9). |
| `tool_result` | after `edit` / `write` | Run `onFileMutation`, record evidence, optionally restore, inject `isError`. |
| `tool_result` | after `bash` | Record what the command left on disk, so a later rollback can tell it from a later edit (P9). |
| `turn_end` | after a turn | Scan for out-of-band changes (P3), evaluate the policy (P7), flush the checkpoint (P1), run `onTurnEnd` (P5), decide the repair (P0). |
| `session_compact` | after a compaction | Restate the contract and the green files; disown summarised results; carry the budget over (P8). |
| `context` | before each model call | Supersede older traces; mark the live one stale once its files change (P2). |

## Synergy with pi-mindplace

[`pi-mindplace`](https://www.npmjs.com/package/@patimweb/pi-mindplace) is the read phase — it builds a
queryable AST graph so the agent knows *what and where* to edit. `pi-sentinel` is the write phase —
it guarantees the change compiles and tests green. Together the graph supplies what sentinel is
missing: **what depends on the thing that just broke.**

| Mindplace artifact | What sentinel does with it |
|---|---|
| `graph-out/graph.json` (`nodes[].sourceFile`, `edges[]`) | Impact analysis: names the dependents of the failing file in the failure payload. |
| `nodes[].label`, `nodes[].centrality` | Focus prioritisation — dependents' diagnostics are promoted by the pruner. |
| Symbol labels per file | Checkpoint labels: `parseConfig, deepMerge (src/config.ts)`. |
| `graph.json` mtime vs. source mtimes | Honesty check — an out-of-date graph is labelled instead of presented as current. |

```
Impact (code graph built 2026-09-14 07:14:22):
  • src/config.ts [parseConfig, deepMerge] → src/index.ts, src/tools/sentinel-status.ts
```

The build time is part of the section, and it is not decoration. A blast radius taken from a graph
that predates the code is evidence about an older revision — the same mistake as a stale verification
trace, one layer down — so the payload says how old it is and warns explicitly when the graph is out
of date.

Staleness is also reported to you, once per session, when the graph was built **before the session
started**:

```
Sentinel: the code graph is older than the code (built 2026-08-25 11:42:07).
Impact analysis and the verification focus are working from an earlier revision —
run mindplace_build to restore them.
```

The trigger is deliberately "older than the session", not "older than the newest file". Editing one
file makes the graph technically stale, so warning on that would fire every turn and tell the agent
only what it just did. A graph from three weeks ago is the case where dependents are genuinely
missing — and because the graph feeds the verification focus, that degrades *verification*, not just
the impact section.

Implementation note: the adapter (`src/clients/mindplace.ts`) reads `graph-out/graph.json` directly
instead of importing `pi-mindplace`. That keeps sentinel free of a tree-sitter dependency, of the
graph's version churn, and of any hard failure when the graph extension is not installed. **Without a
graph every path degrades silently.** Set `impactAwareFocus: false` to turn the integration off.

## What sentinel writes to disk

Nothing is written into your repository. Everything lives under a per-project directory, so the
histories of unrelated repos never mix:

```
~/.pi/sentinel-state/
  <project>-<hash>.json           runtime state: history, metrics, audit trails
  <project>-<hash>/
    checkpoints/<seq>-<id>/       durable turn checkpoints (manifest + blobs)
    verified.json                 the verified-state ledger
    verified-blobs/               restorable copies of states that passed
    verify-cache.json             cached passing runs
    spills/                       full output of payloads that exceeded the budget
```

All writes are atomic (write to a temp file, then rename) and permission-safe (`0600` files, `0700`
directories). A failure to persist is never allowed to fail a verification run — the history is an
audit convenience, not a source of truth.

## Development

Requires a Node build with native TypeScript support: the tests are `.ts` and run without a build
step, so an older runtime cannot even load them. `.node-version` pins 26; CI tests 22.x and 26.x.

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # node --test — 518 tests, 134 suites
npm run audit:runtime # runtime dependencies only
```

Test coverage by module:

| Test file | Covers |
|---|---|
| `tests/extension.test.ts` | **the real hook wiring end-to-end**: registration, P0 injection and all stop conditions, P1 checkpoint flush/rewind, P2 evidence + regression + trace hygiene, P3 out-of-band with a baseline, P4 contract + green evidence, P5 background + budget + coalescing, P7 policy, P8 pre-write gate + scope + compaction, P9 shell gate, rollback honesty, graph freshness |
| `tests/bash-guard.test.ts` | shell classification, quote-aware segmentation, redirect parsing, protection planning |
| `tests/repo-root.test.ts` | repository root resolution from subdirectories, symlinked prefixes, the turn baseline |
| `tests/config.test.ts` | defaults, each feature switchable off, merge semantics, globs, include/exclude |
| `tests/repair.test.ts` | the repair loop's stop conditions and scope narrowing, as pure data |
| `tests/runtime.test.ts` | the session stores are values that share no state |
| `tests/policy.test.ts` | change-policy rules, line counting, sensitive-path classification |
| `tests/pruner.test.ts` | trace pruning, feedback sections, section ordering, honest rollback wording |
| `tests/classify.test.ts` | failure classification, summaries, stable signatures |
| `tests/lines.test.ts` | line ranking shared by the pruner and the classifier |
| `tests/runner.test.ts` | subprocess execution, timeouts, process-tree kills, retries, abort |
| `tests/snapshot.test.ts` | per-mutation and per-turn rollback, untracked files, symlinks, conflicts |
| `tests/checkpoints.test.ts` | flush/list/restore/prune/clear, restart survival, conflict refusal |
| `tests/evidence.test.ts` | verified-state ledger, regression detection, revert, state hashing |
| `tests/mindplace.test.ts` | impact, dependents, labels, staleness, silent degradation |
| `tests/workspace.test.ts` | porcelain parsing, real git repos, the ignore predicate |
| `tests/cache.test.ts` | key construction, TTL, eviction, passing-runs-only |
| `tests/queue.test.ts` | coalescing window, immediate runs, cancellation |
| `tests/spill.test.ts` | output budget, head/tail preview, spill-to-file fallback |
| `tests/feedback.test.ts` | composed failure payload, regression + impact sections, budget cap |
| `tests/contract.test.ts` | revision contract content and switches |
| `tests/redact.test.ts` | secret redaction from output and config dumps |
| `tests/status.test.ts` | status formatting, durations, history rendering |
| `tests/rollback.test.ts` | rollback strategy selection and honest reporting |
| `tests/smoke.test.ts` | imports, tool schemas, graceful non-repo behaviour |

The extension suite drives the real factory against a fake `ExtensionAPI`, so the paths that only
matter at runtime — "is the agent actually woken?", "does the checkpoint really restore?", "is the
command really refused?" — are asserted rather than assumed.

## Design

Following the data-oriented pattern used across `@patimweb` packages:

- All domain data is plain immutable interfaces (`src/types.ts`)
- I/O is isolated in client modules (`src/clients/`)
- Pure functions convert data to display strings (`src/formatting/`)
- Each capability is a single-responsibility tool module (`src/tools/`)
- Config and state persist atomically and permission-safely (`src/config.ts`)

```
src/clients/
  pipeline-runner.ts   subprocess execution, timeouts, aborts
  git-client.ts        repository root resolution, working-tree reset fallback
  snapshot.ts          in-memory pre-state capture & restore
  checkpoints.ts       durable turn checkpoints (P1)
  evidence.ts          verified-state ledger & regression detection (P2)
  workspace.ts         out-of-band change detection & the turn baseline (P3)
  spill.ts             output budget & spill-to-file (P5)
  mindplace.ts         code-graph impact adapter
  policy.ts            change-policy engine (P7)
  bash-guard.ts        shell command classification & protection planning (P9)
  queue.ts             coalescing verification runs (P6)
  repair.ts            the repair loop's state & stop conditions (P0 + P8)
  background.ts        the turn-end run slot (P5)
  cache.ts             verification result reuse (P6)
  escalation.ts        repeated-failure tracker (P6)
  rollback.ts          rollback strategy orchestration
src/formatting/
  pruner.ts            pure trace pruning & failure formatting
  feedback.ts          composed model-visible failure payload
  classify.ts          failure kinds, summaries, signatures
  lines.ts             the shared line-ranking vocabulary
  redact.ts            secret redaction
  status.ts            compact status rendering
src/prompt/
  contract.ts          revision contract (P4)
src/runtime.ts         the stores one session owns, as a value
```

### Session state is a value, not a module global

Everything sentinel remembers about *a session* — the configuration in force and the state it is
scoped to, the turn's pre-state snapshots, the checkpoint being captured, the repeated-failure
counters — used to be module-level. That made its lifetime the process rather than the session: the
state file was chosen by whichever `loadConfig()` had run last, so two sessions wrote their history
into each other's project. It also meant the tools could not be given a store at all, and tests had
to reset globals between cases.

It is now one value, `SentinelRuntime` (`src/runtime.ts`), created per extension instance and handed
to the tools, which are factories over it (`createSentinelStatusTool(runtime)`). The extension
factory accepts an optional runtime, so a test can assert on what the extension recorded without
reaching into a global — and an embedder can hand two extensions one session.

Deliberately *not* in the runtime: the caches keyed by project path (`cache.ts`, `mindplace.ts`,
`git-client.ts`). They are pure functions of the working tree — a graph parsed at a given mtime, a
repository root for a directory, a result keyed by the content hashes of its inputs — so a hit is
correct by construction for the path that produced it, and sharing them across sessions is desirable
rather than dangerous.

### The repair loop is data, not a closure

The loop that makes sentinel useful is also the one that can do damage, so what bounds it is worth
being able to test on its own. `src/clients/repair.ts` holds the loop's entire memory as one plain
value (`RepairState`: attempts spent, the code state already re-prompted for, the file set the cycle
is about, where the cycle began) plus a single pure transition, `decideRepair(state, redTurn)`, which
returns the next state and the decision together.

Nothing in that module reads a file, writes one or talks to the host. The effects a decision asks for
— restoring the cycle's start checkpoint, re-prompting the agent, notifying the human — are performed
by the caller. The stop conditions are therefore a truth table with unit tests instead of something
only observable by driving the whole extension against a fake host.

### The classifier is pure, the decision is not

`bash-guard.ts` answers one question — *what classes of risk does this command carry, and which paths
would they affect?* — with no filesystem and no shell. Whether that means refuse, protect or note,
and the I/O of capturing a pre-state, live in the caller. The interesting half is then unit-testable
against a table of real command lines, which is the only way a classifier like this stays honest as
it grows.

## License

MIT
