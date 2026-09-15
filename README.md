# pi-sentinel

![A knight with a checked shield blocking red error windows on a bridge, while verified files continue past a checkpoint tower towards a green check](https://raw.githubusercontent.com/Smotherer007/pi-sentinel/main/banner.png)

A verification harness for the [pi coding agent](https://github.com/earendil-works/pi).

When the agent stops, what it claims about your code has to be true. Sentinel runs your project's own
checks at the two moments that matter, sends the agent back when they fail, and checkpoints every run
so a bad one costs you nothing.

```
edit / write ──► fast check (e.g. typecheck) ──► red? hint attached to the tool result
                                                   (a multi-file change may be red mid-way)

agent stops ───► checkpoint of the run ──► gate checks (typecheck, lint, test)
                                              │
                                green ◄───────┴───────► red (code failure)
                                  │                        │
                          done, older failures      pruned failure sent back,
                          collapse in context       agent continues (≤ N rounds,
                                                    stops if a round changes nothing)
```

## Install

```bash
pi install npm:@patimweb/pi-sentinel
```

Requires Node 22.18+ (TypeScript sources run with native type stripping). `git` is optional but
recommended — see [What a checkpoint covers](#what-a-checkpoint-covers).

## It works without a config

Sentinel detects the checks your project already has:

| Project | after an edit | before done |
|---|---|---|
| `package.json` script `typecheck` (or `tsconfig.json` + typescript) | typecheck | typecheck |
| script `lint` | — | lint (warning only) |
| script `test` (not the npm placeholder) | — | test |
| `Cargo.toml` | `cargo check` | `cargo test` |
| `go.mod` | `go vet ./...` | `go test ./...` |
| Python with mypy / ruff / pytest declared | mypy | mypy, ruff (warning), pytest |

The package manager follows the lockfile (npm, pnpm, yarn, bun). `/sentinel checks` shows what was
detected and why.

## What it does

**After `edit`/`write`** — the fast checks run (only those whose `files` globs match the edited file),
and a red result is appended to the tool result. It is a hint, not an error: the edit happened, and a
change that spans several files is allowed to be red in the middle. Parallel edits in one message share
one run, and the same failure is not repeated edit after edit.

**When the agent stops** (`agent_end`) — if the run changed files, the gate runs. Red sends the agent a
pruned failure (step, command, the diagnostic lines that matter, what depends on the changed files) and
continues the run. The loop is bounded twice: by `repair.maxAttempts` per user prompt, and by progress
— a repair round that changed no code ends the loop. When sentinel gives up it tells you, and leaves a
note for the agent's next turn so it does not claim success.

**Failures that are not about the code** — a timeout, a missing command, an environment error — never
send the agent back. You get a notification instead.

**Context hygiene** — once the gate passes, earlier sentinel failure messages are replaced with a
one-line "superseded" notice before every model call.

**System prompt** — four short rules: which checks run at the end, only claim what ran, fix causes not
symptoms, stop and explain instead of widening the change.

## Checkpoints and rewind

Every agent run that changed files becomes a checkpoint (kept outside the repo under
`~/.pi/sentinel-state/`). Repair rounds are merged into the checkpoint of the task they repair, so
one rewind undoes the whole prompt.

- `/sentinel rewind` — pick a run and restore its files to how they were before it
- `/sentinel rewind <id> [--force]`
- tool `sentinel_rewind` (`list` / `restore`) for the agent

A rewind never overwrites a file that was changed after the checkpoint (use `--force`), and never
touches files the run did not change.

### What a checkpoint covers

- Files written with `edit`/`write`: the exact pre-state, captured right before the write.
- Files changed any other way (bash, formatters, codegen, `git checkout`) — **in a git repository**:
  a file that was clean when the run started is restored from `HEAD`; a new untracked file is deleted.
  A file that already had uncommitted changes and was then modified by a shell command has no
  recoverable pre-state; sentinel says so instead of guessing.
- Without git, shell changes are neither checkpointed nor used to decide whether the gate runs.

## pi-mindplace

Sentinel does not build or interpret a code graph. When
[pi-mindplace](https://github.com/Smotherer007/pi-mindplace) has written `graph-out/graph.json`,
sentinel reads it for one thing: naming the files that depend on what the agent changed, in the
failure it sends back. Querying the structure, keeping the graph fresh and orienting the agent are
mindplace's job — the contract only points the agent at `mindplace_explain` when a graph exists.

## Commands and tools

| | |
|---|---|
| `/sentinel` or `/sentinel status` | configuration, checks, last result |
| `/sentinel checks` | the same, with why each check was detected |
| `/sentinel verify` | run the gate now |
| `/sentinel rewind [id] [--force]` | restore a run's files |
| `sentinel_verify` (tool) | run the gate, or one step, and get the pruned result |
| `sentinel_rewind` (tool) | list or restore checkpoints |

## Configuration

Optional. `sentinel.config.ts` in the project root (reloaded when it changes):

```ts
import { defineConfig } from "@patimweb/pi-sentinel";

export default defineConfig({
  checks: {
    // "auto" (default) or explicit steps
    afterEdit: [{ name: "typecheck", cmd: "npm run typecheck", files: ["**/*.ts"], timeoutMs: 60_000 }],
    beforeDone: [
      { name: "typecheck", cmd: "npm run typecheck", files: ["**/*.ts"] },
      { name: "lint", cmd: "npm run lint", warnOnly: true },
      { name: "test", cmd: "npm test", timeoutMs: 300_000 },
    ],
  },
  repair: { enabled: true, maxAttempts: 3 },
  checkpoints: { enabled: true, retention: 30 },
  maxOutputTokens: 2500, // model-visible cap; the full text is written to a file
  maxTraceLines: 20,
  exclude: ["**/node_modules/**", "dist/**"],
  mindplace: true,
  contract: true,
});
```

A step: `name`, `cmd`, and optionally `timeoutMs` (default 120 s; the whole process tree is killed),
`cwd` (inside the project), `env`, `files` (globs — the step only runs when a changed file matches),
`warnOnly`. Gate steps run in order and stop at the first blocking failure. Output is redacted for
secrets before anything reaches the model.

## What it is not

Not a sandbox and not a permission system: it does not block shell commands or protect paths. It
verifies and it can undo.

## Development

```bash
npm ci
npm run typecheck
npm test   # unit tests, hook tests against a fake pi, and end-to-end runs in a real pi session with a scripted model
```

## License

MIT
