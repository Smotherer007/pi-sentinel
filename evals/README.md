# Evals: does sentinel make the agent better?

`compare.mjs` runs the same tasks with a real model, once without and once with pi-sentinel, and
judges the result with hidden acceptance checks (the *oracle*) the agent never sees.

```bash
# from the repository root; uses your normal pi login / API keys
node evals/compare.mjs --model <model-pattern> --repeats 2
```

Useful options: `--provider <name>`, `--tasks rename-money,discount-bug`, `--variants baseline,sentinel`,
`--parallel 2`, `--timeout-min 15`, `--pi <path>`, `--mindplace ../pi-mindplace/index.ts` (enables the
`mindplace` and `sentinel+mindplace` variants), `--keep` (keep the temp workspaces). `--help` lists all.

Each run happens in a fresh temp copy of the task project (a git repo). Only the variant's extensions
load (`-ne`), so globally installed extensions do not leak into the baseline.

## Tasks

| task | what it tests |
|---|---|
| `rename-money` | multi-file rename + new parameter; a caller is easy to miss, output must not change |
| `discount-bug` | three bugs from a customer report; the existing tests cover almost nothing |
| `duration-feature` | new parser used by the CLI; edge cases and invalid input |

Every oracle was checked against the unmodified project (fails) and a reference solution (passes).

## Output

`evals/runs/<timestamp>/`

- `summary.md` / `summary.json` — per task and variant: oracle pass rate, share of checks passed,
  tests/typecheck green at the end, time, model calls, tokens, cost, sentinel repair rounds and edit hints
- `<task>/<variant>-<n>/run.json` — metrics, sentinel messages, failed oracle checks
- `events.jsonl` — the full pi event stream, `diff.patch`, `oracle.json`, `final-checks.json`, `stderr.log`
- `meta.json` — pi version, node, options, sentinel commit

One run per variant is an anecdote; use `--repeats` of at least 2–3 before reading anything into the
numbers.
