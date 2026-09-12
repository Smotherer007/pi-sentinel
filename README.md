# pi-sentinel

Astra/Codex-style in-loop verification & rollback hardening for the [pi coding agent](https://github.com/earendil-works/pi).

Sentinel prunes failed tool-execution traces (saving tokens), runs configured validation pipelines (`tsc`, `eslint`, tests), and restores the files it changed when invariant violations are detected — so bad code never pollutes the agent's context.

## Installation

```bash
# Install from npm (once published)
pi install npm:@patimweb/pi-sentinel

# Install from local path during development
pi install /path/to/pi-sentinel
```

## How it works

Sentinel hooks into the pi loop at two points — **after a file mutation** (`edit`/`write`) and **at the end of a turn** — runs the configured pipelines, and turns any failure into a token-cheap, self-correcting signal for the agent:

```
                          pi Agent Loop
   ┌────────────────────────────────────────────────────────────────────────┐
   │   edit / write                       end of agent turn                  │
   └──────────────────┬─────────────────────────────┬───────────────────────┘
   tool_call: status  │                             │   turn_end
   "Mutation detected" │                             │   runs onTurnEnd
   ─→ verifying…       │                             │   pipelines
                      ▼                             ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │                     Sentinel Guard (armed)                            │
   │                                                                        │
   │   onFileMutation ─→ type-check          onTurnEnd ─→ unit-tests        │
   │                                                                        │
   │   PipelineRunner: subprocess, timeout, buffered output                 │
   └────────────────────────────┬────────────────────────────────────────────┘
                                │
             ┌──────────────────┴──────────────────┐
             ▼                                     ▼
   all steps exit 0                       some step exits ≠ 0
   (checks passed)                        (checks failed)
             │                                     │
             ▼                                     ▼
   clear status · green PASS            TracePruner keeps the ~N most
   loop continues                        critical error lines (maxTraceLines)
                                                   │
                                                   ▼
                                    ┌──────────────────────────────────┐
                                    │  autoRollback && !warnOnly ?      │
                                    └───────────────┬──────────────┬────┘
                                                  yes            no
                                                    ▼              ▼
                                    SnapshotStore restore    keep changes,
                                    (pre-mutation state,     recover manually
                                     incl. new files)
                                                    |              |
                                                    └──────┬───────┘
                                                           ▼
                                           formatError() → injected back into
                                           the loop (tool_result isError / notify)
```

The guard is opt-in-rollback: by default a failed check is **fed back** so the model can self-correct, and the working tree is only restored when the project sets `autoRollback: true`. `warnOnly` steps never trigger a restore — but their output *is* surfaced as a warning instead of being swallowed.

## Tools

| Tool | Description |
|------|-------------|
| `sentinel_verify` | Run verification pipelines on demand (mutation or turn). Optionally restore on failure. |
| `sentinel_rollback` | Restore the files changed this turn (`mode: "turn"`), or hard-reset to HEAD (`mode: "head"`). |
| `sentinel_status` | Show active config, git state, turn snapshot, rollback + verification history. |

## Rollback model

Sentinel snapshots the pre-state of every file the agent touches in the
`tool_call` hook — *before* the mutation runs — and keeps it in a per-turn
journal. On a critical failure it restores exactly those files:

- **Mutation failure** (`onFileMutation`) → only the offending mutation's files
  are restored.
- **Turn failure** (`onTurnEnd`) → every file touched during the turn is
  restored, including files the agent **newly created** via `write`.
- **Untouched files are never modified**, so unrelated uncommitted work of the
  user survives.

`git checkout -- .` is only used as a fallback when no snapshot was captured
(e.g. a mutation that bypassed the hooks), or when the user explicitly asks for
`mode: "head"`. Files larger than 4 MB are not snapshotted; a restore touching
such a file is reported as *partial*.

## Commands

| Command | Description |
|---------|-------------|
| `/sentinel` | Show help. |
| `/sentinel status` | Show current state. |
| `/sentinel verify` | Run `onFileMutation` pipelines now. |
| `/sentinel test` | Run `onTurnEnd` pipelines now. |
| `/sentinel rollback` | Roll back the working tree. |
| `/sentinel config` | Dump the active configuration. |

## Configuration

Create `sentinel.config.ts` in the project root (or `~/.sentinel.config.ts`):

```ts
import { defineConfig } from "@patimweb/pi-sentinel";

export default defineConfig({
  enabled: true,
  // Restore is opt-in. Like Claude Code / Codex, a failed check is fed back
  // to the agent so it can self-correct. Set `autoRollback: true` only if you
  // also want sentinel to restore the files it changed on a failure.
  autoRollback: false,
  maxTraceLines: 12,

  pipelines: {
    // Keep per-mutation checks FAST — they run after every edit.
    onFileMutation: [
      { name: "type-check", cmd: "npx tsc --noEmit --incremental", timeoutMs: 15000 },
      { name: "linter", cmd: "npx eslint --quiet", timeoutMs: 8000, warnOnly: true },
    ],
    // Put the slow, whole-project checks here — they run once per turn.
    onTurnEnd: [
      { name: "unit-tests", cmd: "npm test", timeoutMs: 30000 },
    ],
  },

  // Only files matching these are verified. Empty = all non-excluded files.
  include: ["src/**/*.ts", "tests/**/*.ts"],
  exclude: ["**/node_modules/**", "**/.git/**", "**/*.md", "dist/**"],
});
```

> **warnOnly**: `linter` is `warnOnly` by default so projects without eslint
> don't trigger a restore. A `warnOnly` failure never restores, but its pruned
> output is still surfaced to the agent as a warning.
>
> **Per-step options**: each step additionally accepts `cwd` (relative to the
> project) and `env` (merged into the child process environment).
>
> **Performance**: since `onFileMutation` runs after *every* `edit`/`write`, keep
> it to incremental checks. Full type-checks and test suites belong in
> `onTurnEnd`. A byte-identical rewrite is detected and skips the pipeline
> entirely.

## Hooks & trigger points

| Hook | Trigger | Pipeline group | What it does on failure |
|------|---------|----------------|--------------------------|
| `session_start` | session starts | — | Announce `Sentinel armed` if `enabled`; resolve config cwd-aware |
| `turn_start` | agent turn starts | — | Begin a fresh snapshot scope for the turn |
| `tool_call` | before `edit` / `write` | — | Snapshot the target file, set status indicator |
| `tool_result` | after `edit` / `write` | `onFileMutation` | Prune trace → optional restore → inject `isError` into the result |
| `turn_end` | after an agent turn | `onTurnEnd` | Prune trace → optional restore → wake the agent with the error |
| `sentinel_verify` | on demand | `mutation` or `turn` | Report / optional restore |

Every event reloads `sentinel.config.ts` from disk (mtime-cache-busted), so config changes take effect without restarting pi.

## Design

Following the data-oriented pattern used across `@patimweb` packages:

- All domain data is represented as plain immutable interfaces (`src/types.ts`)
- I/O is isolated in client modules (`src/clients/`)
- Pure formatting functions convert data to display strings (`src/formatting/`)
- Each capability is a single-responsibility tool module (`src/tools/`)
- Config/state uses atomic, permission-safe file persistence (`src/config.ts`)
- Runtime state is scoped per project (`~/.pi/sentinel-state/<project>.json`)

## Synergy with pi-mindplace

| Package | Phase | Role |
|---------|-------|------|
| `pi-mindplace` | Read phase | Builds a minimal AST-graph context so Pi knows exactly what/where to edit. |
| `pi-sentinel` | Write phase | Guarantees every change passes type/lint/test checks and discards failed attempts before they compromise context. |

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

MIT
