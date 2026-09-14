# Evals — does sentinel actually help?

Everything else in this repository measures sentinel *against itself*: 627 unit and end-to-end tests
say the mechanisms do what they were built to do. None of them answers the only question a user has —
**does this make my agent better, or does it just get in the way?** That is what this directory is
for.

The honest starting point: sentinel has no such number today. What exists is an anecdote from the
session that built the last release — three stale reds delivered for states that had already been
fixed, one of which cost two of three bounded repair attempts — and that anecdote is exactly why the
freshness binding, the delivery-time demotion and the stall fix exist. An anecdote is not a metric.

## What gets measured

| Metric | How it is derived (mechanically, from state sentinel already writes) |
|---|---|
| **Interventions** | `autoFixHistory` entries with `outcome: "injected"`, plus `rollbackHistory` entries. One per action sentinel took on its own. |
| **Damage prevented** | A rollback/regression revert that restored a file which, at the point the turn ended, failed a check the agent had not re-run. Counted as `rollbackHistory` rows whose `reason` names a step, filtered to turns where the pre-state was captured (`checkpoints`). |
| **Nuisance** | Verdicts that were *true when produced* but no longer true when read, plus `superseded` rows, plus stalls (`identical code state`) — i.e. messages that asked for work that no longer existed. |
| **False positives** | A red verdict whose diagnostics do not reproduce on a re-run of the same step over the *same* content (`verification cache` miss ⇒ re-run ⇒ green). Also: a flake that reached the loop (the three today). |
| **Recovered** | A red turn followed, within the same cycle, by a green turn whose changed set intersects the failing one — the loop closed. |
| **Explained** | A failure payload that names the step, the file, the line **and** an action, measured by the pruner: does the payload contain at least one `DiagnosticRank` line and one "do this" line, and does it stay under `maxOutputTokens`. |

Two of these are countable today (`interventions`, `recovered`, and the `superseded` half of
`nuisance`), because the counters were added for this: `autoFixHistory` now records `superseded`, and
`/sentinel doctor` reports the open cycle, the newest red and the newest green. The rest need the
runner below.

## The corpus

Six task shapes, because they stress different mechanisms. Each task is a fixture repository plus a
scripted *sequence of agent actions*, some of which are deliberately wrong.

| # | Task | Seeds | What it should exercise |
|---|---|---|---|
| 1 | Implement a feature | A half-done implementation, one call site left unupdated | The verification loop, dependent-file impact, and "fix the cause, not the symptom" |
| 2 | Fix a bug | The bug, plus a red test that does not cover it | That sentinel does not accept "the test passes" as evidence of the fix |
| 3 | Refactor | A moved symbol with stale imports in files the agent is not editing | Impact focus, blast radius, and out-of-band detection |
| 4 | Add tests | A test file that passes but asserts nothing; a flaky test with a `sleep` | That a green run with no coverage is not mistaken for progress (the metric that needs a human or a judge) |
| 5 | Upgrade a dependency | A major-version break with a lockfile change | Policy (`allowLockfileChanges`), the lockfile as a manifest input, and rollback of a partial upgrade |
| 6 | Change an API | A signature change plus a formatter that rewrites files mid-run | The inter-extension bus, staleness of a verdict whose inputs moved, and demotion at delivery |

## The runner (next slice)

`evals/run.mjs` — not written yet, and deliberately specified before it is:

1. **Fixture per task**: copy `evals/fixtures/<task>/` into a temp directory, `git init`, commit.
2. **Agent adapter**: a real agent (`pi --print` against a model, or a subagent) *or* a **scripted
   agent** — the same sequence of tool calls, no LLM, no cost. The scripted path is what makes this
   runnable in CI and in a PR; the real path is what makes it convincing.
3. **Instrumentation**: load the extension factory against a fake pi (the pattern the tests already
   use), so every hook, notification and injected message is observable, and read the persisted state
   (`~/.pi/sentinel-state/<scope>.json`) for the counters.
4. **Report**: one row per task with the six numbers, plus the *evidence* for each — the payloads
   that were injected, the files restored, the verdicts discarded. Numbers without the payloads are
   the kind of claim this repository does not make.
5. **Baseline**: every task runs twice, with sentinel enabled and disabled. A number is only
   interesting next to its baseline; "sentinel intervened 4 times" says nothing without "and the
   disabled run shipped two broken files".

## What this cannot prove

- The scripted agent is a *simulation* of mistakes, and simulations encode their author's
  assumptions. It can show that sentinel catches the mistakes it was written for; it cannot show that
  those are the mistakes agents make.
- Metric 4 ("add tests") and parts of metric 6 ("explained") need a judgement about *content*, not a
  counter. They will need a judge model, and a judge is a cost and a variance — reported as such, not
  folded into a headline.
- Nothing here measures the thing users feel most: latency. A run that is safe and slow is still a
  run someone turns off. The turn-end background mode and the debounce window are where that fight
  happens, and `metricsLines` already records `avg check` per step.
